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
 * POST /suscribir-membresia
 * Auth: Bearer JWT del miembro. Body: { tier: <slug>, embedded?: boolean }
 *
 * Pago IN-APP vía Stripe Connect (direct charge): crea una Checkout Session
 * EMBEBIDA sobre la CUENTA CONECTADA del estudio (precio inline del tier) y
 * devuelve { client_secret, account } para montar el Embedded Checkout en el
 * modal de EKKO. La activación la dispara el webhook de Connect (no acá).
 *
 *   - Sin STRIPE_SECRET_KEY        → { reason: 'stripe_pendiente' }.
 *   - Estudio sin cobros activados → { reason: 'cobros_no_activos' }.
 * STRYV es la plataforma; el dinero cae directo al banco del estudio.
 */

interface Body {
  tier?: string;
  embedded?: boolean;
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
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede comprar membresía');

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
      return ok({ activated: false, reason: 'stripe_pendiente' });
    }

    // Cuenta conectada del estudio (direct charges).
    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) {
      return ok({ activated: false, reason: 'cobros_no_activos' });
    }

    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) {
      return badRequest('Este plan no tiene un precio válido');
    }

    const stripe = getStripe();
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
      accountId
    );

    const feePct = Number(optionalEnv('EKKO_FEE_PERCENT', '0')) || 0;
    const meta = { app: 'ekko', usuario_id: socio.id, tier_id: tier.id };
    const currency = (tier.moneda || 'mxn').toLowerCase();
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';

    const baseParams = esPaquete
      ? {
          mode: 'payment' as const,
          customer: customerId,
          line_items: [
            {
              price_data: { currency, product_data: { name: tier.nombre }, unit_amount: tier.precio_centavos },
              quantity: 1
            }
          ],
          payment_intent_data: {
            metadata: meta,
            ...(feePct > 0 ? { application_fee_amount: Math.round((tier.precio_centavos * feePct) / 100) } : {})
          },
          metadata: meta
        }
      : {
          mode: 'subscription' as const,
          customer: customerId,
          line_items: [
            {
              price_data: {
                currency,
                product_data: { name: tier.nombre },
                unit_amount: tier.precio_centavos,
                recurring: { interval: 'month' as const }
              },
              quantity: 1
            }
          ],
          subscription_data: {
            metadata: meta,
            ...(feePct > 0 ? { application_fee_percent: feePct } : {})
          },
          metadata: meta
        };

    const origin =
      event.headers.origin || event.headers.referer?.replace(/\/+$/, '') || optionalEnv('URL', '');

    // Embedded → modal de EKKO (client_secret + la cuenta conectada, que el front
    // necesita para inicializar Stripe.js sobre esa cuenta).
    if (body.embedded !== false) {
      const session = await stripe.checkout.sessions.create(
        { ...baseParams, ui_mode: 'embedded', redirect_on_completion: 'never' },
        { stripeAccount: accountId }
      );
      return ok({ activated: false, client_secret: session.client_secret, account: accountId });
    }

    // Hosted (redirect) — fallback.
    const session = await stripe.checkout.sessions.create(
      {
        ...baseParams,
        success_url: `${origin}/app/perfil?suscripcion=ok`,
        cancel_url: `${origin}/app/perfil?suscripcion=cancelado`
      },
      { stripeAccount: accountId }
    );
    return ok({ activated: false, url: session.url });
  } catch (err) {
    console.error('[suscribir-membresia]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
