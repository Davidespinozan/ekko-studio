import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada, getOrCreateSocioCustomer } from '../_lib/connectBilling';

/**
 * POST /crear-pago-intent
 * Auth: Bearer JWT del miembro. Body: { tier: <slug> }
 *
 * Pago IN-APP con Stripe ELEMENTS (formulario oscuro propio de EKKO), sobre la
 * CUENTA CONECTADA del estudio (direct charge). Devuelve { clientSecret, account }:
 *   - Mensual → subscription `default_incomplete` (precio creado en la cuenta
 *     conectada; client_secret de la 1ª factura → cobro inmediato + 3DS in-modal).
 *   - Paquete → PaymentIntent (pago único).
 * El front confirma con <PaymentElement>. La activación la dispara el webhook.
 *   - Sin STRIPE_SECRET_KEY        → { reason: 'stripe_pendiente' }.
 *   - Estudio sin cobros activados → { reason: 'cobros_no_activos' }.
 */

interface Body {
  tier?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.tier) return badRequest('tier requerido');

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
      .select('id, tenant_id, rol, email')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede pagar su membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, activo, tenant_id, nombre, precio_centavos, moneda, tipo')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ reason: 'stripe_pendiente' });
    }

    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) {
      return ok({ reason: 'cobros_no_activos' });
    }
    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) {
      return badRequest('Este plan no tiene un precio válido');
    }

    const stripe = getStripe();
    const opt = { stripeAccount: accountId };
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
      accountId
    );

    const currency = (tier.moneda || 'mxn').toLowerCase();
    const metadata = { app: 'ekko', usuario_id: socio.id, tier_id: tier.id };
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';

    if (esPaquete) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: tier.precio_centavos,
          currency,
          customer: customerId,
          metadata,
          automatic_payment_methods: { enabled: true }
        },
        opt
      );
      return ok({ clientSecret: intent.client_secret, account: accountId, modo: 'pago' });
    }

    // Mensual: el precio recurrente debe existir EN la cuenta conectada.
    // prices.create con product_data lo crea inline (idempotente por tier+cuenta).
    const price = await stripe.prices.create(
      {
        unit_amount: tier.precio_centavos,
        currency,
        recurring: { interval: 'month' },
        product_data: { name: tier.nombre }
      },
      { ...opt, idempotencyKey: `ekko_price_${tier.id}_${accountId}` }
    );

    const sub = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata,
        expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret']
      },
      opt
    );

    const inv = sub.latest_invoice as unknown as {
      payment_intent?: { client_secret?: string };
      confirmation_secret?: { client_secret?: string };
    } | null;
    const clientSecret = inv?.confirmation_secret?.client_secret ?? inv?.payment_intent?.client_secret ?? null;
    if (!clientSecret) return serverError('No se pudo iniciar el cobro de la suscripción');

    void optionalEnv; // (reservado para fee futuro)
    return ok({ clientSecret, account: accountId, modo: 'suscripcion', subscriptionId: sub.id });
  } catch (err) {
    console.error('[crear-pago-intent]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
