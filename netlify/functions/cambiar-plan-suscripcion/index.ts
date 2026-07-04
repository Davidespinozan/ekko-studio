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
 * POST /cambiar-plan-suscripcion
 * Auth: Bearer JWT del miembro. Body: { tier: <slug> }
 *
 * Cambio de plan MENSUAL↔MENSUAL SIN re-pedir tarjeta: hace `subscriptions.update`
 * sobre la suscripción vigente del miembro (cobra la tarjeta guardada). El ajuste
 * de precio se prorratea al próximo período (`create_prorations`) → sin cobro
 * inmediato ni 3DS, por eso no se abre modal de pago. Quitar la fricción del
 * cambio de plan = no perder suscripciones.
 *
 * Solo aplica a planes mensuales sobre una suscripción activa. Si el miembro NO
 * tiene suscripción (paquete / cancelado) → { reason: 'sin_suscripcion' } y el
 * front cae al flujo normal de pago (PaymentModal). Los paquetes (pago único)
 * también caen a ese flujo. El tier lo actualizamos AQUÍ server-side: el webhook
 * de `customer.subscription.updated` solo sincroniza status/periodo, no el tier.
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
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede cambiar su plan');

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
    // El swap solo tiene sentido en planes mensuales (suscripción). Los paquetes
    // son pago único → deben ir por crear-pago-intent.
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';
    if (esPaquete) return ok({ reason: 'sin_suscripcion' });
    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) {
      return badRequest('Este plan no tiene un precio válido');
    }

    // Membresía vigente con suscripción de Stripe (la que vamos a re-precio).
    const { data: mem } = await admin
      .from('membresias')
      .select('id, tier_id, status, stripe_subscription_id')
      .eq('usuario_id', socio.id)
      .not('stripe_subscription_id', 'is', null)
      .in('status', ['activa', 'past_due'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mem?.stripe_subscription_id) return ok({ reason: 'sin_suscripcion' });
    if (mem.tier_id === tier.id) return badRequest('Ya tienes este plan');

    if (!process.env.STRIPE_SECRET_KEY) return ok({ reason: 'stripe_pendiente' });

    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) return ok({ reason: 'cobros_no_activos' });

    const stripe = getStripe();
    const opt = { stripeAccount: accountId };

    // Precio recurrente destino EN la cuenta conectada (idempotente por tier+precio).
    const currency = (tier.moneda || 'mxn').toLowerCase();
    const price = await stripe.prices.create(
      {
        unit_amount: tier.precio_centavos,
        currency,
        recurring: { interval: 'month' },
        product_data: { name: tier.nombre }
      },
      { ...opt, idempotencyKey: `ekko_price_${tier.id}_${tier.precio_centavos}_${accountId}` }
    );

    // Item vigente de la suscripción → cambiar su precio (proration al próximo
    // período: sin cobro inmediato, cobra la tarjeta guardada como default).
    const sub = await stripe.subscriptions.retrieve(mem.stripe_subscription_id, opt);
    const itemId = sub.items.data[0]?.id;
    if (!itemId) return serverError('La suscripción no tiene un ítem para actualizar');

    await stripe.subscriptions.update(
      mem.stripe_subscription_id,
      {
        items: [{ id: itemId, price: price.id }],
        proration_behavior: 'create_prorations',
        metadata: { app: 'ekko', usuario_id: socio.id, tier_id: tier.id }
      },
      opt
    );

    // Tier server-side (el webhook de subscription.updated NO toca el tier).
    const nowIso = new Date().toISOString();
    await admin.from('membresias').update({ tier_id: tier.id, updated_at: nowIso }).eq('id', mem.id);
    await admin.from('usuarios').update({ membresia_tier: tier.slug }).eq('id', socio.id);

    return ok({ success: true, tier: tier.slug });
  } catch (err) {
    console.error('[cambiar-plan-suscripcion]', err instanceof Error ? err.message : err);
    return serverError('No pudimos cambiar tu plan. Intenta de nuevo.');
  }
};
