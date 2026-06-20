import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe, getOrCreateCustomer } from '../_lib/stripe';

/**
 * POST /suscribir-membresia
 * Auth: Bearer JWT del miembro (compra/cambia SU propio plan).
 * Body: { tier: <slug de un tier activo del tenant> }
 *
 * Punto ÚNICO de enchufe de Stripe para la compra self-serve (D4: suscripción
 * mensual por tier, sin trial). Crea una Checkout Session hosted y devuelve
 * { url } para redirigir. La activación REAL la dispara el webhook
 * (checkout.session.completed → activar_membresia). NO se activa acá.
 *
 * Sin STRIPE_SECRET_KEY (Stripe aún no conectado): responde
 * { activated: false, reason: 'stripe_pendiente' } y recepción activa en
 * mostrador. No fingimos pago.
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

    // Resolver al miembro por SU token (nunca usuario_id del body).
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
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede comprar membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Validar que el tier es del tenant, está activo y tiene precio en Stripe.
    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, stripe_price_id, activo, tenant_id')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }

    // Sin Stripe configurado: no se cobra ni se activa. Recepción activa en mostrador.
    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ activated: false, reason: 'stripe_pendiente' });
    }
    if (!tier.stripe_price_id) {
      return badRequest('Este plan aún no tiene precio configurado en Stripe');
    }

    const stripe = getStripe();
    const customerId = await getOrCreateCustomer(stripe, admin, {
      id: socio.id,
      email: socio.email ?? null,
      nombre: socio.nombre ?? null
    });

    // Base de URLs: Netlify expone URL del sitio; fallback al origin del request.
    const base =
      optionalEnv('URL') ||
      optionalEnv('DEPLOY_PRIME_URL') ||
      event.headers.origin ||
      '';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: tier.stripe_price_id, quantity: 1 }],
      // metadata en la session (checkout.session.completed) y en la suscripción
      // (red de seguridad para el webhook). EKKO no tiene trial → sin trial_*.
      metadata: { usuario_id: socio.id, tier_id: tier.id },
      subscription_data: { metadata: { usuario_id: socio.id, tier_id: tier.id } },
      payment_method_collection: 'always',
      allow_promotion_codes: true,
      success_url: `${base}/app/perfil?suscripcion=ok`,
      cancel_url: `${base}/app/perfil?suscripcion=cancelado`
    });

    return ok({ url: session.url });
  } catch (err) {
    console.error('[suscribir-membresia]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
