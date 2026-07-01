import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe, getOrCreateCustomer } from '../_lib/stripe';

/**
 * POST /crear-pago-intent
 * Auth: Bearer JWT del miembro.
 * Body: { tier: <slug> }
 *
 * Backend del pago IN-APP con Stripe Elements (modal propio de EKKO, sin salir a
 * la página de Stripe). Devuelve un `clientSecret` que el front confirma con
 * <PaymentElement>:
 *   - Mensual  → subscription `default_incomplete` (client_secret de la 1ª
 *     factura). Sin trial → cobro inmediato + 3DS en el modal.
 *   - Paquete  → PaymentIntent (pago único por el monto del tier).
 * La activación de la membresía la dispara el webhook (no el front).
 *
 * Sin STRIPE_SECRET_KEY → { reason: 'stripe_pendiente' } (activá en recepción).
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
      .select('id, tenant_id, rol, nombre, email')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede pagar su membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, stripe_price_id, activo, tenant_id, tipo, precio_centavos, moneda')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ reason: 'stripe_pendiente' });
    }

    const stripe = getStripe();
    const customerId = await getOrCreateCustomer(stripe, admin, {
      id: socio.id,
      email: socio.email ?? null,
      nombre: socio.nombre ?? null
    });
    const metadata = { usuario_id: socio.id, tier_id: tier.id };
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';

    if (esPaquete) {
      // Pago único por el monto del paquete.
      const intent = await stripe.paymentIntents.create({
        amount: tier.precio_centavos,
        currency: (tier.moneda ?? 'mxn').toLowerCase(),
        customer: customerId,
        metadata,
        automatic_payment_methods: { enabled: true }
      });
      return ok({ clientSecret: intent.client_secret, modo: 'pago' });
    }

    // Suscripción mensual sin trial → default_incomplete + confirmar en el modal.
    if (!tier.stripe_price_id) {
      return badRequest('Este plan aún no tiene precio configurado en Stripe');
    }
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: tier.stripe_price_id }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata,
      expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret']
    });

    // El client_secret cambió de lugar entre versiones de la API: en "basil"
    // vive en confirmation_secret; antes en payment_intent. Lo buscamos en ambos.
    const inv = sub.latest_invoice as unknown as {
      payment_intent?: { client_secret?: string };
      confirmation_secret?: { client_secret?: string };
    } | null;
    const clientSecret = inv?.confirmation_secret?.client_secret ?? inv?.payment_intent?.client_secret ?? null;
    if (!clientSecret) return serverError('No se pudo iniciar el cobro de la suscripción');

    return ok({ clientSecret, modo: 'suscripcion', subscriptionId: sub.id });
  } catch (err) {
    console.error('[crear-pago-intent]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
