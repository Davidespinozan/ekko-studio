import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';
import { ejecutarOperacionesSuscripcion } from '../_lib/operacionesSuscripcion';
import { esStaffActivo } from '../_lib/staff';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /staff-cancelar-membresia
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, motivo, inmediata?: boolean }
 *
 * Da de baja la membresía de un miembro desde mostrador / admin. EKKO es mes a
 * mes: "me quiero dar de baja" es una petición típica de recepción, y antes solo
 * el propio miembro podía hacerlo desde su app (o alguien entraba al dashboard
 * de Stripe).
 *
 *  · Con suscripción Stripe y sin `inmediata`: NO se renueva
 *    (`cancel_at_period_end`) y el miembro conserva el acceso hasta el fin de lo
 *    que ya pagó. Stripe primero; si la RPC rechaza, se revierte.
 *  · Inmediata — siempre que no haya suscripción (mostrador / paquete), si está
 *    en pausa, o si se pide: primero la RPC (estado + asiento + bitácora) y
 *    después `subscriptions.cancel`. Cancelar en Stripe no se puede deshacer; si
 *    fallara, la fila ya está cerrada, se reporta y el reconciliador de
 *    `cron-expirar-membresias` cancela la suscripción huérfana.
 *
 * El gate de rol + tenant + motivo vive en la RPC `staff_cancelar_membresia`,
 * que corre con el token del staff.
 */

interface Body {
  usuario_id?: string;
  motivo?: string;
  inmediata?: boolean;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
    if (motivo.length < 5) return badRequest('Indica el motivo de la baja');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: staff } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(staff)) {
      return forbidden('Solo recepción o admin pueden dar de baja una membresía');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Membresía viva (o en pausa) + aislamiento de tenant ANTES de tocar Stripe.
    const { data: mem } = await admin
      .from('membresias')
      .select('id, tenant_id, stripe_subscription_id, status')
      .eq('usuario_id', body.usuario_id)
      .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mem) return badRequest('El miembro no tiene una membresía vigente que dar de baja');
    if (mem.tenant_id !== staff.tenant_id) {
      return forbidden('No puedes modificar la membresía de otro estudio');
    }

    let subId: string | null = mem.stripe_subscription_id ?? null;
    let accountId: string | null = null;
    if (subId && process.env.STRIPE_SECRET_KEY) {
      accountId = (await resolverCuentaConectada(admin, staff.tenant_id)).accountId;
      if (!accountId) subId = null;
    } else {
      subId = null;
    }
    const stripe = subId && accountId ? getStripe() : null;

    // Sin suscripción no hay "fin de periodo" que esperar; una pausada no factura.
    const inmediata = body.inmediata === true || !stripe || mem.status === 'pausada';

    const llamarRpc = () =>
      asUser.rpc('staff_cancelar_membresia', {
        p_usuario_id: body.usuario_id,
        p_inmediata: inmediata,
        p_motivo: motivo
      });
    const humano = (m: string) => (m.includes(': ') ? m.split(': ').slice(1).join(': ') : m);

    // 1) RPC → 2) Stripe. Inmediata (R2-B) y al fin del periodo (PKG-02H): la RPC
    // deja la operación en stripe_operaciones_suscripcion en la MISMA transacción
    // que la baja (cancelar_suscripcion / cancelar_fin_periodo). Aquí se ejecuta;
    // si Stripe falla queda `fallida` con evidencia durable, aviso al admin y
    // reintento. Antes, la baja al fin del periodo iba Stripe primero con un
    // rollback best-effort que, si fallaba, nadie registraba.
    const { data, error } = await llamarRpc();
    if (error) return error.message.includes('EKKO_') ? badRequest(humano(error.message)) : errorInterno('staff-cancelar-membresia', error);

    let stripeCancelado: boolean | null = null;
    if (stripe && subId && accountId) {
      try {
        const cobro = await ejecutarOperacionesSuscripcion(admin, { usuarioId: body.usuario_id });
        stripeCancelado = cobro.aplicadas > 0 && cobro.fallidas === 0;
      } catch (e) {
        stripeCancelado = false;
        await reportarErrorServidor('staff-cancelar-membresia', e, {
          usuario_id: body.usuario_id,
          subscription_id: subId,
          nota: 'La baja quedó en la base; la operación en Stripe quedó pendiente en stripe_operaciones_suscripcion.'
        });
      }
    }

    return ok({ success: true, result: data, inmediata, stripe_cancelado: stripeCancelado });
  } catch (err) {
    console.error('[staff-cancelar-membresia]', err instanceof Error ? err.message : err);
    return serverError('No pudimos dar de baja la membresía');
  }
};
