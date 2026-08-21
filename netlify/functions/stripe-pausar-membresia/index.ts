import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';
import { enviarPushAUsuario } from '../_lib/push';

/**
 * POST /stripe-pausar-membresia
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, pausar: boolean, motivo }
 *
 * Pausa (o reanuda) la membresía de un miembro: viaje, lesión, etc. Antes un
 * "congelado" a mano seguía pagando o había que cancelarlo.
 *  1) Stripe primero: pause_collection (behavior 'void': no se factura mientras
 *     dure) o null para reanudar — sobre la cuenta conectada del estudio.
 *  2) RPC staff_pausar_membresia con el token del staff (gate de rol + tenant,
 *     estados, aviso al miembro, audit_log). Si la RPC rechaza, se revierte Stripe.
 * Paquetes / membresías de mostrador (sin suscripción) solo pasan por la RPC.
 * (SALA pausar-membresia.)
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
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!staff || !['admin', 'recepcionista'].includes(staff.rol)) {
      return forbidden('Solo recepción o admin pueden pausar membresías');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Membresía a tocar (viva si pausamos, pausada si reanudamos) + aislamiento de tenant ANTES de Stripe.
    const { data: mem } = await admin
      .from('membresias')
      .select('id, tenant_id, stripe_subscription_id, status')
      .eq('usuario_id', body.usuario_id)
      .in('status', body.pausar ? ['trialing', 'activa', 'past_due'] : ['pausada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (mem && mem.tenant_id !== staff.tenant_id) {
      return forbidden('No puedes modificar la membresía de otro estudio');
    }

    let subId: string | null = mem?.stripe_subscription_id ?? null;
    let accountId: string | null = null;
    if (subId && process.env.STRIPE_SECRET_KEY) {
      accountId = (await resolverCuentaConectada(admin, staff.tenant_id)).accountId;
      if (!accountId) subId = null;
    } else {
      subId = null; // paquete / mostrador / Stripe no configurado → solo RPC
    }

    const stripe = subId && accountId ? getStripe() : null;
    const payload = body.pausar ? { behavior: 'void' as const } : null;

    // 1) Stripe primero (para poder revertir si la RPC rechaza).
    if (stripe && subId && accountId) {
      await stripe.subscriptions.update(subId, { pause_collection: payload }, { stripeAccount: accountId });
    }

    // 2) RPC con el token del staff (gate de rol + tenant + audit).
    const { data, error } = await asUser.rpc('staff_pausar_membresia', {
      p_usuario_id: body.usuario_id,
      p_pausar: body.pausar,
      p_motivo: motivo
    });
    if (error) {
      if (stripe && subId && accountId) {
        const revert = body.pausar ? null : { behavior: 'void' as const };
        try {
          await stripe.subscriptions.update(subId, { pause_collection: revert }, { stripeAccount: accountId });
        } catch (e) {
          console.error('[stripe-pausar-membresia] rollback Stripe falló', e instanceof Error ? e.message : e);
        }
      }
      const humano = error.message.includes(': ') ? error.message.split(': ').slice(1).join(': ') : error.message;
      return badRequest(humano);
    }

    // Push del aviso que dejó la RPC (best-effort).
    await enviarPushAUsuario(admin, body.usuario_id, {
      titulo: body.pausar ? 'Tu membresía está en pausa' : 'Tu membresía volvió',
      mensaje: body.pausar
        ? 'No se te cobrará ni podrás reservar hasta que se reactive.'
        : 'Ya puedes volver a reservar.',
      url: '/app/perfil',
      tag: body.pausar ? 'membresia_pausada' : 'membresia_reactivada'
    });

    return ok({ success: true, result: data, stripe_pausado: Boolean(subId) });
  } catch (err) {
    console.error('[stripe-pausar-membresia]', err instanceof Error ? err.message : err);
    return serverError('No pudimos actualizar la membresía');
  }
};
