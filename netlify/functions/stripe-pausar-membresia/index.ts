import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv } from '../_lib/env';
import { ejecutarOperacionesSuscripcion } from '../_lib/operacionesSuscripcion';
import { esStaffActivo } from '../_lib/staff';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /stripe-pausar-membresia
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, pausar: boolean, motivo }
 *
 * Pausa (o reanuda) la membresía de un miembro: viaje, lesión, etc.
 *
 * PKG-02H · orden de R2-B: 1) RPC `staff_pausar_membresia` con el token del staff
 * (gate de rol + tenant, estados, intención de pausa comercial EKKO-138, aviso,
 * audit_log) que deja la OPERACIÓN de cobro en `stripe_operaciones_suscripcion`
 * en la MISMA transacción; 2) el ejecutor la aplica en Stripe con la llave de esa
 * operación. Si Stripe falla, EKKO no se deshace: la operación queda `fallida`,
 * visible en Operación, y se reintenta (cron diario / "sincronizar cobro").
 * Antes: Stripe primero y la RPC después, sin intención durable ni llave; un fallo
 * a medias dejaba a Stripe y a EKKO en desacuerdo sin que nadie lo supiera.
 * Paquetes / membresías de mostrador (sin suscripción) solo pasan por la RPC.
 *
 * EKKO-139: reactivar durante una SANCIÓN no crea reanudación (la RPC lo decide y
 * re-asegura la suspensión de la sanción); el cobro vuelve al levantarla.
 */
interface Body {
  usuario_id?: string;
  pausar?: boolean;
  motivo?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');
    if (typeof body.pausar !== 'boolean') return badRequest('pausar (true/false) requerido');
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
    if (motivo.length < 3) return badRequest('Motivo obligatorio para esta acción');

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
      return forbidden('Solo recepción o admin pueden pausar membresías');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // 1) RPC con el token del staff: decide, deja la intención y la operación durable.
    const { data, error } = await asUser.rpc('staff_pausar_membresia', {
      p_usuario_id: body.usuario_id,
      p_pausar: body.pausar,
      p_motivo: motivo
    });
    if (error) {
      if (!error.message.includes('EKKO_')) return errorInterno('stripe-pausar-membresia', error);
      const humano = error.message.includes(': ') ? error.message.split(': ').slice(1).join(': ') : error.message;
      return badRequest(humano);
    }
    const resultado = (data ?? {}) as { operacion_cobro?: boolean; cobro_suspendido_por_sancion?: boolean; stripe_subscription_id?: string | null };

    // 2) Ejecutor: aplica en Stripe lo que la base dejó escrito (si hay Stripe).
    let stripePausado: boolean | null = null; // null = no había nada que aplicar en Stripe
    let cobroPendiente = false;
    if (resultado.operacion_cobro && process.env.STRIPE_SECRET_KEY) {
      try {
        const cobro = await ejecutarOperacionesSuscripcion(admin, { usuarioId: body.usuario_id });
        stripePausado = cobro.aplicadas > 0 && cobro.fallidas === 0;
        cobroPendiente = cobro.fallidas > 0;
      } catch (e) {
        stripePausado = false;
        cobroPendiente = true;
        await reportarErrorServidor('stripe-pausar-membresia', e, {
          usuario_id: body.usuario_id,
          nota: 'La membresía cambió en la base; la operación de cobro quedó pendiente en stripe_operaciones_suscripcion.'
        });
      }
    } else if (resultado.operacion_cobro) {
      cobroPendiente = true; // sin Stripe configurado: queda pendiente para el ejecutor
    }

    // El push NO se manda aquí: la RPC deja el aviso en `notificaciones` sin
    // `push_enviado_at` y cron-push lo reparte en el siguiente minuto (EKKO-033).
    return ok({
      success: true,
      result: data,
      stripe_pausado: stripePausado === true,
      cobro_pendiente: cobroPendiente,
      cobro_suspendido_por_sancion: Boolean(resultado.cobro_suspendido_por_sancion)
    });
  } catch (err) {
    console.error('[stripe-pausar-membresia]', err instanceof Error ? err.message : err);
    return serverError('No pudimos actualizar la membresía');
  }
};
