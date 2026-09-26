import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';

/**
 * POST /stripe-cancelar-suscripcion
 * Auth: Bearer JWT del miembro. Body: { reactivar?: boolean }.
 *
 * Cancela la suscripción del miembro AL FINAL DEL PERIODO (cancel_at_period_end),
 * o la reactiva (reactivar:true → cancel_at_period_end:false). Todo in-app, sobre
 * la cuenta conectada. El webhook customer.subscription.updated sincroniza el
 * estado en la membresía. La suscripción se deriva del JWT, nunca del body.
 */

interface Body {
  reactivar?: boolean;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const reactivar = body.reactivar === true;

    if (!process.env.STRIPE_SECRET_KEY) return badRequest('Pagos no configurados');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: socio } = await asUser
      .from('usuarios')
      .select('id, tenant_id')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: mem } = await admin
      .from('membresias')
      .select('stripe_subscription_id')
      .eq('usuario_id', socio.id)
      // 'pausada' incluida: quien pausó por un viaje y decide no volver debe
      // poder darse de baja sin tener que pedir que lo reanuden primero.
      .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
      .not('stripe_subscription_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mem?.stripe_subscription_id) {
      return badRequest('No tenés una suscripción activa para gestionar');
    }

    const { accountId } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId) return badRequest('El estudio no tiene cobros activados');

    const stripe = getStripe();
    const sub = await stripe.subscriptions.update(
      mem.stripe_subscription_id,
      { cancel_at_period_end: !reactivar },
      { stripeAccount: accountId }
    );

    return ok({ success: true, cancel_at_period_end: sub.cancel_at_period_end });
  } catch (err) {
    console.error('[stripe-cancelar-suscripcion]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
