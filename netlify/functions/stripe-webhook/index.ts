import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe, clasificarEvento, periodoFinFromSubscription, extraerMontoDeEvento } from '../_lib/stripe';

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

  // Webhook de Connect: el signing secret es el del endpoint de Connect
  // (STRIPE_CONNECT_WEBHOOK_SECRET); cae al genérico por compatibilidad.
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
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

  // Connect: los eventos de la cuenta conectada traen event.account. Las
  // lecturas a Stripe (retrieve de la suscripción) deben ir sobre esa cuenta.
  const connectedAccount = (stripeEvent as unknown as { account?: string }).account;
  const acctOpt = connectedAccount ? { stripeAccount: connectedAccount } : undefined;

  try {
    const accion = clasificarEvento(stripeEvent);
    // usuario del pago (para payment_events): se captura en cada rama donde ya
    // lo conocemos; en renovaciones (sync) se resuelve por la suscripción.
    let usuarioIdPago: string | null = null;

    if (accion.kind === 'activar') {
      // Mensual: leer la suscripción para el periodo_fin. Paquete (pago único):
      // no hay suscripción → periodo_fin lo decide activar_membresia por tipo.
      let periodoFin: string | null = null;
      if (accion.subscription_id) {
        const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
        periodoFin = periodoFinFromSubscription(sub);
      }
      const { error } = await admin.rpc('activar_membresia', {
        p_usuario_id: accion.usuario_id,
        p_tier_id: accion.tier_id,
        p_stripe_subscription_id: accion.subscription_id,
        p_stripe_customer_id: accion.customer_id,
        p_periodo_fin: periodoFin
      });
      if (error) throw new Error(`activar_membresia: ${error.message}`);
      usuarioIdPago = accion.usuario_id;
    } else if (accion.kind === 'activar-sub') {
      // Suscripción in-app (Elements): leer metadata + periodo de la suscripción,
      // sobre la cuenta conectada (Connect).
      const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
      const usuarioId = sub.metadata?.usuario_id;
      const tierId = sub.metadata?.tier_id;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (usuarioId && tierId && customerId) {
        const { error } = await admin.rpc('activar_membresia', {
          p_usuario_id: usuarioId,
          p_tier_id: tierId,
          p_stripe_subscription_id: accion.subscription_id,
          p_stripe_customer_id: customerId,
          p_periodo_fin: periodoFinFromSubscription(sub)
        });
        if (error) throw new Error(`activar_membresia (sub): ${error.message}`);
        usuarioIdPago = usuarioId;
      }
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

    // ── Registrar el pago en payment_events (métricas de dinero del admin) ────
    // Solo eventos de cobranza real (invoice.paid / payment_intent.succeeded).
    // Falla suave: si no se puede registrar, NO revierte la activación ya hecha.
    const monto = extraerMontoDeEvento(stripeEvent);
    if (monto) {
      try {
        let tenantIdPago: string | null = null;
        // Renovación (sync): resolver usuario + tenant por la suscripción.
        if (!usuarioIdPago && monto.stripe_subscription_id) {
          const { data: mem } = await admin
            .from('membresias')
            .select('usuario_id, tenant_id')
            .eq('stripe_subscription_id', monto.stripe_subscription_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          usuarioIdPago = mem?.usuario_id ?? null;
          tenantIdPago = mem?.tenant_id ?? null;
        }
        if (usuarioIdPago && !tenantIdPago) {
          const { data: u } = await admin
            .from('usuarios')
            .select('tenant_id')
            .eq('id', usuarioIdPago)
            .maybeSingle();
          tenantIdPago = u?.tenant_id ?? null;
        }
        await admin.from('payment_events').upsert(
          {
            stripe_event_id: stripeEvent.id,
            stripe_event_type: stripeEvent.type,
            tenant_id: tenantIdPago,
            usuario_id: usuarioIdPago,
            monto_centavos: monto.monto_centavos,
            moneda: monto.moneda,
            status: monto.status,
            stripe_invoice_id: monto.stripe_invoice_id,
            stripe_payment_intent_id: monto.stripe_payment_intent_id,
            stripe_subscription_id: monto.stripe_subscription_id,
            stripe_customer_id: monto.stripe_customer_id,
            raw_payload: stripeEvent as unknown as Record<string, unknown>,
            processed_at: new Date().toISOString()
          },
          { onConflict: 'stripe_event_id', ignoreDuplicates: true }
        );
      } catch (pagoErr) {
        console.error('[stripe-webhook] no se pudo registrar payment_events', pagoErr);
      }
    }

    return ok({ received: true });
  } catch (err) {
    // Borrar el registro de idempotencia para que Stripe reintente y reprocese.
    await admin.from('stripe_webhook_events').delete().eq('id', stripeEvent.id);
    console.error('[stripe-webhook] procesamiento', err);
    return serverError(err instanceof Error ? err.message : 'webhook error');
  }
};
