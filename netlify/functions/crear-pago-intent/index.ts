import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe, llavePrecio } from '../_lib/stripe';
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
      .select('id, tenant_id, rol, email, status, sancionado_at')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    // Una sanción del estudio no se compra: el pago crearía la membresía y el
    // trigger dejaría la cuenta suspendida de todos modos (Fase 1 identidad).
    if (socio.sancionado_at || socio.status === 'revocado') {
      return forbidden('Tu cuenta está suspendida por el estudio. Escríbenos para resolverlo antes de comprar un plan.');
    }
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede pagar su membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, activo, en_venta, tenant_id, nombre, precio_centavos, moneda, tipo')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }
    // `en_venta=false` = el estudio dejó de VENDER el plan (sus miembros actuales
    // lo conservan). La landing y el perfil ya no lo muestran, pero sin este
    // chequeo seguía siendo comprable llamando a la API con el slug.
    if (tier.en_venta === false) {
      return badRequest('Este plan ya no está a la venta');
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

    // CustomerSession → el <PaymentElement> muestra la tarjeta guardada para
    // pagar de un tap (recompra sin re-teclear). El filtro incluye 'unspecified'
    // porque las tarjetas guardadas por la suscripción quedan con ese
    // allow_redisplay y si no, no se listarían.
    let customerSessionClientSecret: string | null = null;
    try {
      const cs = await stripe.customerSessions.create(
        {
          customer: customerId,
          components: {
            payment_element: {
              enabled: true,
              features: {
                payment_method_redisplay: 'enabled',
                payment_method_allow_redisplay_filters: ['always', 'limited', 'unspecified'],
                payment_method_save: 'enabled',
                payment_method_save_usage: 'off_session',
                payment_method_remove: 'enabled'
              }
            }
          }
        },
        opt
      );
      customerSessionClientSecret = cs.client_secret;
    } catch (e) {
      // Si falla, seguimos sin tarjeta guardada (formulario normal).
      console.error('[crear-pago-intent] customerSession', e instanceof Error ? e.message : e);
    }

    const currency = (tier.moneda || 'mxn').toLowerCase();
    const metadata = { app: 'ekko', usuario_id: socio.id, tier_id: tier.id };
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';
    // Comisión de la plataforma (EKKO_FEE_PERCENT, default 0). Antes solo se
    // aplicaba en el Checkout (fallback); los flujos Elements no cobraban fee.
    const feePct = Number(optionalEnv('EKKO_FEE_PERCENT', '0')) || 0;

    if (esPaquete) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: tier.precio_centavos,
          currency,
          customer: customerId,
          metadata,
          automatic_payment_methods: { enabled: true },
          ...(feePct > 0 ? { application_fee_amount: Math.round((tier.precio_centavos * feePct) / 100) } : {})
        },
        opt
      );
      return ok({ clientSecret: intent.client_secret, account: accountId, modo: 'pago', customerSessionClientSecret });
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
      { ...opt, idempotencyKey: llavePrecio({ tierId: tier.id, accountId, centavos: tier.precio_centavos, currency, nombre: tier.nombre }) }
    );

    const sub = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: price.id }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata,
        ...(feePct > 0 ? { application_fee_percent: feePct } : {}),
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

    return ok({ clientSecret, account: accountId, modo: 'suscripcion', subscriptionId: sub.id, customerSessionClientSecret });
  } catch (err) {
    console.error('[crear-pago-intent]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
