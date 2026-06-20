import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /suscribir-membresia
 * Auth: Bearer JWT del miembro (compra/cambia SU propio plan).
 * Body: { tier: <slug de un tier activo del tenant> }
 *
 * Punto ÚNICO de enchufe de Stripe para la compra self-serve (D4: suscripción
 * mensual por tier, sin trial). La activación real vive en el RPC keystone
 * `activar_membresia` — NO se activa acá salvo el atajo simulado.
 *
 * HOY (sin Stripe → falta STRIPE_SECRET_KEY):
 *   - { activated: false, reason: 'stripe_pendiente' }. La UI muestra "pago en
 *     camino — acercate a recepción". NO se cobra ni se activa (no fingimos un
 *     pago). Mientras tanto, recepción activa en mostrador
 *     (reception-activar-membresia).
 *
 * CONECTAR STRIPE — reemplazar el bloque [TODO STRIPE]:
 *   1. Crear stripe.checkout.sessions.create({ mode: 'subscription',
 *      line_items: [{ price: tier.stripe_price_id, quantity: 1 }],
 *      customer?: ..., metadata: { usuario_id, tier_id } }) y devolver { url }.
 *   2. iniciarCheckout (front) ya redirige si viene { url }.
 *   3. La activación la dispara el webhook → activar_membresia. NO activar acá.
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
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede comprar membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Validar que el tier es del tenant y está activo.
    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, stripe_price_id, activo, tenant_id')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }

    // ── [TODO STRIPE] ────────────────────────────────────────────────────────
    // Con STRIPE_SECRET_KEY: crear Checkout Session y devolver { url }.
    //   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    //   const session = await stripe.checkout.sessions.create({
    //     mode: 'subscription',
    //     line_items: [{ price: tier.stripe_price_id, quantity: 1 }],
    //     metadata: { usuario_id: socio.id, tier_id: tier.id },
    //     success_url: ..., cancel_url: ...
    //   });
    //   return ok({ url: session.url });
    if (!process.env.STRIPE_SECRET_KEY) {
      // Sin Stripe: no se cobra ni se activa. Recepción activa en mostrador.
      return ok({ activated: false, reason: 'stripe_pendiente' });
    }
    // ──────────────────────────────────────────────────────────────────────────

    // (Inalcanzable hasta completar el bloque de arriba; placeholder explícito.)
    return ok({ activated: false, reason: 'stripe_pendiente' });
  } catch (err) {
    console.error('[suscribir-membresia]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
