import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';

/**
 * POST /stripe-portal
 * Auth: Bearer JWT del miembro. Body: {} (ninguno).
 *
 * Crea una sesión del Customer Portal de Stripe y devuelve { url } para
 * redirigir. El portal (hosted por Stripe) cubre cancelar, cambiar tarjeta y
 * ver facturas con UNA sola función — en vez de una por acción. El cliente NO
 * elige el customer: se deriva de SU membresía (nunca del body).
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ reason: 'stripe_pendiente' });
    }

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: socio } = await asUser
      .from('usuarios')
      .select('id')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');

    // El customer sale de SU membresía (el miembro puede leer la suya por RLS).
    const { data: mem } = await asUser
      .from('membresias')
      .select('stripe_customer_id')
      .eq('usuario_id', socio.id)
      .not('stripe_customer_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mem?.stripe_customer_id) {
      return badRequest('No tenés una suscripción activa para gestionar');
    }

    const base =
      optionalEnv('URL') ||
      optionalEnv('DEPLOY_PRIME_URL') ||
      event.headers.origin ||
      '';

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: mem.stripe_customer_id,
      return_url: `${base}/app/perfil`
    });

    return ok({ url: session.url });
  } catch (err) {
    console.error('[stripe-portal]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
