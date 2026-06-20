import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe, clasificarEvento, periodoFinFromSubscription } from '../_lib/stripe';

/**
 * POST /stripe-webhook — materializa los cambios de la suscripción del miembro.
 *
 * Robustez (patrones de HSC):
 *   - Firma verificada sobre el BODY CRUDO (no JSON.parse).
 *   - Idempotencia: tabla `stripe_webhook_events` (PK = event.id). Si el evento
 *     ya se procesó → 200 duplicate. Si el procesamiento FALLA → borra el
 *     registro para que el reintento de Stripe lo reprocese.
 *   - Orden: el RPC `sync_membresia_stripe` ignora eventos más viejos.
 *
 * Activación (checkout.session.completed) → RPC `activar_membresia` (el MISMO
 * punto que usa recepción en mostrador). Cambios posteriores (renovó, falló el
 * pago, canceló) → RPC `sync_membresia_stripe`. Sin STRIPE_WEBHOOK_SECRET es
 * un no-op (no rompe el deploy).
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    return ok({ skipped: 'stripe_no_configurado' });
  }

  const stripe = getStripe();
  const sig = event.headers['stripe-signature'];
  if (!sig) return badRequest('Falta stripe-signature');

  // Body crudo: Netlify puede entregarlo en base64.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] firma inválida', err);
    return badRequest('Firma inválida');
  }

  const admin = createClient(
    requireEnv('VITE_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );

  // ── Idempotencia: insert-or-ignore por event.id ───────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from('stripe_webhook_events')
    .upsert({ id: stripeEvent.id, type: stripeEvent.type }, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (insErr) {
    console.error('[stripe-webhook] idempotencia', insErr);
    return serverError('No se pudo registrar el evento');
  }
  if (!inserted || inserted.length === 0) {
    return ok({ received: true, duplicate: true });
  }

  try {
    const accion = clasificarEvento(stripeEvent);

    if (accion.kind === 'activar') {
      // Leer la suscripción para el periodo_fin real.
      const sub = await stripe.subscriptions.retrieve(accion.subscription_id);
      const { error } = await admin.rpc('activar_membresia', {
        p_usuario_id: accion.usuario_id,
        p_tier_id: accion.tier_id,
        p_stripe_subscription_id: accion.subscription_id,
        p_stripe_customer_id: accion.customer_id,
        p_periodo_fin: periodoFinFromSubscription(sub)
      });
      if (error) throw new Error(`activar_membresia: ${error.message}`);
    } else if (accion.kind === 'sync') {
      const { error } = await admin.rpc('sync_membresia_stripe', {
        p_stripe_subscription_id: accion.subscription_id,
        p_estado: accion.estado,
        p_periodo_fin: accion.periodo_fin,
        p_cancel_at_period_end: accion.cancel_at_period_end,
        p_event_at: accion.event_at
      });
      if (error) throw new Error(`sync_membresia_stripe: ${error.message}`);
    }
    // kind === 'ignore' → no-op (evento que no nos interesa).

    return ok({ received: true });
  } catch (err) {
    // Borrar el registro de idempotencia para que Stripe reintente y reprocese.
    await admin.from('stripe_webhook_events').delete().eq('id', stripeEvent.id);
    console.error('[stripe-webhook] procesamiento', err);
    return serverError(err instanceof Error ? err.message : 'webhook error');
  }
};
