import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /stripe-webhook — ESQUELETO (inerte hasta conectar Stripe).
 *
 * Materializa la membresía del miembro vía el RPC keystone `activar_membresia`
 * (la MISMA que usa la activación en mostrador). Sin STRIPE_WEBHOOK_SECRET
 * responde 200 sin hacer nada (no rompe el deploy).
 *
 * CONECTAR STRIPE — completar los 2 [TODO STRIPE]:
 *   1. Verificar firma: stripe.webhooks.constructEvent(rawBody, sig, secret).
 *   2. Mapear eventos:
 *        - checkout.session.completed / customer.subscription.created|updated
 *            → activar_membresia(usuario_id, tier_id, stripe_subscription_id,
 *                 stripe_customer_id, periodo_fin)   [IDs del metadata/objeto]
 *        - customer.subscription.deleted → marcar la membresía 'cancelada'.
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Stripe todavía no conectado → no-op explícito (no falla el deploy).
    return ok({ skipped: 'stripe_no_configurado' });
  }

  try {
    // [TODO STRIPE 1] Verificar firma:
    //   const sig = event.headers['stripe-signature'];
    //   const stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    //
    // [TODO STRIPE 2] Mapear stripeEvent.type → activar/cancelar:
    //   const admin = createClient(requireEnv('VITE_SUPABASE_URL'),
    //                              requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    //                              { auth: { persistSession: false } });
    //   await admin.rpc('activar_membresia', { p_usuario_id, p_tier_id,
    //       p_stripe_subscription_id, p_stripe_customer_id, p_periodo_fin });

    void createClient; // evita unused import hasta implementar
    void requireEnv;
    return ok({ received: true });
  } catch (err) {
    console.error('[stripe-webhook]', err);
    return serverError(err instanceof Error ? err.message : 'webhook error');
  }
};
