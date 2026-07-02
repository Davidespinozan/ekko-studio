import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada, getOrCreateSocioCustomer } from '../_lib/connectBilling';

/**
 * POST /stripe-setup-intent
 * Auth: Bearer JWT del miembro. Body: {}.
 *
 * Crea un SetupIntent en la cuenta conectada para que el miembro registre/actualice
 * su tarjeta IN-APP (Elements), sin ir al portal de Stripe. Devuelve { clientSecret,
 * account }. Al confirmarse, el front llama a /stripe-actualizar-tarjeta con el
 * payment_method para fijarla como default del customer y de la suscripción.
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    if (!process.env.STRIPE_SECRET_KEY) return ok({ reason: 'stripe_pendiente' });

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
      .select('id, tenant_id, email')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) return ok({ reason: 'cobros_no_activos' });

    const stripe = getStripe();
    const acctOpt = { stripeAccount: accountId };
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
      accountId
    );

    const si = await stripe.setupIntents.create(
      {
        customer: customerId,
        payment_method_types: ['card'],
        usage: 'off_session',
        metadata: { app: 'ekko', usuario_id: socio.id }
      },
      acctOpt
    );

    return ok({ clientSecret: si.client_secret, account: accountId });
  } catch (err) {
    console.error('[stripe-setup-intent]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
