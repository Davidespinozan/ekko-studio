import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './env';

/**
 * Cliente Stripe + helpers de billing. Patrones tomados de HSC (proyecto
 * hermano ya en producción), adaptados a Netlify/Node y al RPC `activar_membresia`.
 *
 * Los mappers (`mapStripeStatus`, `clasificarEvento`) son PUROS a propósito: el
 * webhook delega en ellos para poder testear la lógica de mapeo sin Stripe.
 */

// apiVersion FIJA (HSC la dejó implícita = frágil al actualizar el SDK).
const API_VERSION = '2025-08-27.basil';

let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    apiVersion: API_VERSION,
    typescript: true
  });
  return _stripe;
}

// ── Estado interno de la membresía (subconjunto del CHECK de la tabla) ───────
export type EstadoMembresia = 'activa' | 'past_due' | 'cancelada';

/**
 * Status de una suscripción de Stripe → estado interno.
 *   active/trialing → 'activa'
 *   past_due        → 'past_due' (GRACIA: mantiene acceso mientras Stripe reintenta)
 *   canceled/unpaid/incomplete_expired → 'cancelada'
 *   incomplete/paused/otros → null (transitorios: NO tocar la membresía)
 */
export function mapStripeStatus(stripeStatus: string): EstadoMembresia | null {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'activa';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'cancelada';
    default:
      return null;
  }
}

/**
 * `current_period_end` cambió de lugar entre versiones de la API de Stripe:
 * en "basil" (2025-08) vive en los items, no en el top-level de la suscripción.
 * Lo buscamos en ambos lados.
 */
export function periodoFinFromSubscription(sub: unknown): string | null {
  const s = sub as {
    current_period_end?: number;
    items?: { data?: Array<{ current_period_end?: number }> };
  };
  const ts = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return typeof ts === 'number' ? new Date(ts * 1000).toISOString() : null;
}

// ── Clasificación de eventos del webhook (PURA) ─────────────────────────────
export type EventoClasificado =
  | {
      kind: 'activar';
      usuario_id: string;
      tier_id: string;
      subscription_id: string | null; // null en paquetes (pago único, sin suscripción)
      customer_id: string;
      event_at: string;
    }
  | {
      kind: 'sync';
      subscription_id: string;
      estado: EstadoMembresia;
      periodo_fin: string | null;
      cancel_at_period_end: boolean | null;
      event_at: string;
    }
  | {
      // Activación de una suscripción creada in-app (Elements): la primera
      // factura se pagó → hay que crear la membresía. El webhook lee el
      // metadata (usuario_id/tier_id) y el periodo desde la suscripción.
      kind: 'activar-sub';
      subscription_id: string;
      event_at: string;
    }
  | { kind: 'ignore'; reason: string };

/**
 * Traduce un evento de Stripe a una acción interna, SIN llamar a Stripe.
 * (La activación necesita además leer la suscripción para el periodo_fin; eso
 * lo hace el webhook, no este mapper.)
 */
export function clasificarEvento(event: Stripe.Event): EventoClasificado {
  const event_at = new Date(event.created * 1000).toISOString();

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      const usuario_id = s.metadata?.usuario_id;
      const tier_id = s.metadata?.tier_id;
      const subscription_id =
        typeof s.subscription === 'string' ? s.subscription : s.subscription?.id ?? null;
      const customer_id = typeof s.customer === 'string' ? s.customer : s.customer?.id;
      // 'subscription' = mensual; 'payment' = paquete de créditos (pago único).
      if (s.mode !== 'subscription' && s.mode !== 'payment') {
        return { kind: 'ignore', reason: 'no_es_suscripcion_ni_pago' };
      }
      if (!usuario_id || !tier_id || !customer_id) {
        return { kind: 'ignore', reason: 'faltan_datos_en_session' };
      }
      return { kind: 'activar', usuario_id, tier_id, subscription_id, customer_id, event_at };
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const estado =
        event.type === 'customer.subscription.deleted' ? 'cancelada' : mapStripeStatus(sub.status);
      if (!estado) return { kind: 'ignore', reason: `status_transitorio:${sub.status}` };
      return {
        kind: 'sync',
        subscription_id: sub.id,
        estado,
        periodo_fin: periodoFinFromSubscription(sub),
        cancel_at_period_end: sub.cancel_at_period_end ?? null,
        event_at
      };
    }

    case 'invoice.payment_failed':
    case 'invoice.paid': {
      const inv = event.data.object as Stripe.Invoice & {
        subscription?: string | { id: string };
        billing_reason?: string;
      };
      const subscription_id =
        typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
      if (!subscription_id) return { kind: 'ignore', reason: 'invoice_sin_suscripcion' };
      // Primera factura de una suscripción → ACTIVAR (crea la membresía). El
      // resto (renovación, fallo) → sincronizar el estado de la existente.
      if (event.type === 'invoice.paid' && inv.billing_reason === 'subscription_create') {
        return { kind: 'activar-sub', subscription_id, event_at };
      }
      return {
        kind: 'sync',
        subscription_id,
        estado: event.type === 'invoice.payment_failed' ? 'past_due' : 'activa',
        periodo_fin: null,
        cancel_at_period_end: null,
        event_at
      };
    }

    case 'payment_intent.succeeded': {
      // Paquete de créditos pagado in-app (pago único con Elements). El
      // metadata lo pusimos en crear-pago-intent. (Los PI de suscripción no
      // llevan este metadata → se ignoran acá y se activan por invoice.paid.)
      const pi = event.data.object as Stripe.PaymentIntent;
      const usuario_id = pi.metadata?.usuario_id;
      const tier_id = pi.metadata?.tier_id;
      const customer_id = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
      if (!usuario_id || !tier_id || !customer_id) {
        return { kind: 'ignore', reason: 'payment_intent_sin_metadata' };
      }
      return { kind: 'activar', usuario_id, tier_id, subscription_id: null, customer_id, event_at };
    }

    default:
      return { kind: 'ignore', reason: `evento_no_manejado:${event.type}` };
  }
}

/**
 * Devuelve el customer de Stripe del miembro, creándolo si no existe.
 * Anti-duplicados: reusa por `metadata.usuario_id` (NO por email — el email
 * puede repetirse entre personas y cruzaría facturación). Lección de HSC.
 */
export async function getOrCreateCustomer(
  stripe: Stripe,
  admin: SupabaseClient,
  usuario: { id: string; email: string | null; nombre?: string | null }
): Promise<string> {
  // 1. ¿Ya guardado en alguna membresía del usuario?
  const { data: prev } = await admin
    .from('membresias')
    .select('stripe_customer_id')
    .eq('usuario_id', usuario.id)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prev?.stripe_customer_id) return prev.stripe_customer_id;

  // 2. ¿Existe en Stripe por metadata?
  try {
    const found = await stripe.customers.search({
      query: `metadata['usuario_id']:'${usuario.id}'`,
      limit: 1
    });
    if (found.data[0]) return found.data[0].id;
  } catch {
    // customers.search puede no estar habilitado en cuentas nuevas → seguimos.
  }

  // 3. Crear. idempotencyKey evita duplicados ante reintentos del mismo alta.
  const customer = await stripe.customers.create(
    {
      email: usuario.email ?? undefined,
      name: usuario.nombre ?? undefined,
      metadata: { usuario_id: usuario.id }
    },
    { idempotencyKey: `ekko_customer_${usuario.id}` }
  );
  return customer.id;
}
