import Stripe from 'stripe';
import { createHash } from 'node:crypto';
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
    typescript: true,
    // Un blip de red en un cobro/webhook no debe fallar a la primera (Stripe
    // reintenta de forma segura con idempotency keys automáticas).
    maxNetworkRetries: 2,
    appInfo: { name: 'EKKO Studio', url: 'https://ekkostudio.app' }
  });
  return _stripe;
}

// ── Estado interno de la membresía (subconjunto del CHECK de la tabla) ───────
export type EstadoMembresia = 'activa' | 'past_due' | 'pausada' | 'cancelada';

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
      /**
       * Id del PaymentIntent del pago único (null en suscripciones, que ya son
       * idempotentes por subscription_id). En Checkout, la sesión y su PI llevan
       * el mismo metadata y AMBOS eventos activan: sin esta llave el paquete se
       * acreditaba dos veces.
       */
      referencia: string | null;
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
      // Activación de una suscripción in-app (Elements): la 1ª factura se pagó
      // → crear la membresía. El webhook lee el metadata + periodo de la sub.
      kind: 'activar-sub';
      subscription_id: string;
      event_at: string;
    }
  | {
      // Invitados extra pagados en la app (pago único, no membresía): sumar los
      // extras pagados a la reserva.
      kind: 'invitados-extra';
      reserva_id: string;
      cantidad: number;
      usuario_id: string | null;
      event_at: string;
    }
  | {
      // Reembolso (desde el dashboard Express del estudio o por API): registrar
      // en payment_events y avisar al equipo. No revierte créditos/membresía
      // automáticamente: el estudio decide (queda en el historial del miembro).
      kind: 'reembolso';
      charge_id: string;
      payment_intent_id: string | null;
      amount_refunded: number;
      currency: string;
      customer_id: string | null;
      event_at: string;
    }
  | {
      // Connect: Stripe aprobó/cambió la cuenta conectada del estudio → refrescar
      // los flags que gatean el cobro sin esperar a que alguien abra /admin/cobros.
      kind: 'cuenta-conectada';
      account_id: string;
      charges_enabled: boolean;
      details_submitted: boolean;
      payouts_enabled: boolean;
      event_at: string;
    }
  | { kind: 'ignore'; reason: string };

/**
 * La cuenta Stripe de la plataforma se COMPARTE con otros productos (SALA, HSC).
 * Todo lo que crea EKKO lleva `metadata.app = 'ekko'`; si un objeto trae otra
 * app, el evento no es nuestro. (Sin metadata → se asume nuestro: las facturas
 * de renovación no siempre arrastran el metadata de la suscripción.)
 */
export const APP_ID = 'ekko';
export function esDeOtraApp(meta: { app?: string } | null | undefined): boolean {
  return typeof meta?.app === 'string' && meta.app !== '' && meta.app !== APP_ID;
}

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
      if (esDeOtraApp(s.metadata)) return { kind: 'ignore', reason: 'app_ajena' };
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
      const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null;
      return {
        kind: 'activar', usuario_id, tier_id, subscription_id, customer_id,
        referencia: s.mode === 'payment' ? pi : null,
        event_at
      };
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      if (esDeOtraApp(sub.metadata)) return { kind: 'ignore', reason: 'app_ajena' };
      // pause_collection (pausa de facturación) deja la sub 'active' en Stripe:
      // sin esto un subscription.updated volvería a poner la membresía activa.
      const estado =
        event.type === 'customer.subscription.deleted'
          ? 'cancelada'
          : sub.pause_collection
            ? 'pausada'
            : mapStripeStatus(sub.status);
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
        // API 2025+: invoice.subscription se movió a parent.subscription_details.
        parent?: { subscription_details?: { subscription?: string | { id: string }; metadata?: { app?: string } } };
        subscription_details?: { metadata?: { app?: string } };
      };
      const metaSub = inv.parent?.subscription_details?.metadata ?? inv.subscription_details?.metadata;
      if (esDeOtraApp(metaSub)) return { kind: 'ignore', reason: 'app_ajena' };
      const subRef = inv.subscription ?? inv.parent?.subscription_details?.subscription;
      const subscription_id = typeof subRef === 'string' ? subRef : subRef?.id;
      if (!subscription_id) return { kind: 'ignore', reason: 'invoice_sin_suscripcion' };
      // 1ª factura de la suscripción (Elements) → ACTIVAR (crea la membresía).
      // Renovación → sync; payment_failed → past_due.
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
      const pi = event.data.object as Stripe.PaymentIntent;
      if (esDeOtraApp(pi.metadata)) return { kind: 'ignore', reason: 'app_ajena' };
      // Invitados extra pagados en la app (pago único, sin membresía).
      if (pi.metadata?.tipo === 'invitados_extra') {
        const reserva_id = pi.metadata?.reserva_id;
        const cantidad = Number.parseInt(pi.metadata?.cantidad ?? '', 10);
        if (!reserva_id || !Number.isInteger(cantidad) || cantidad <= 0) {
          return { kind: 'ignore', reason: 'invitados_extra_sin_datos' };
        }
        return { kind: 'invitados-extra', reserva_id, cantidad, usuario_id: pi.metadata?.usuario_id ?? null, event_at };
      }
      // Paquete pagado in-app (pago único con Elements). El metadata lo pusimos
      // en crear-pago-intent. (Los PI de suscripción no llevan este metadata.)
      const usuario_id = pi.metadata?.usuario_id;
      const tier_id = pi.metadata?.tier_id;
      const customer_id = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
      if (!usuario_id || !tier_id || !customer_id) {
        return { kind: 'ignore', reason: 'payment_intent_sin_metadata' };
      }
      return { kind: 'activar', usuario_id, tier_id, subscription_id: null, customer_id, referencia: pi.id, event_at };
    }

    case 'charge.refunded': {
      const ch = event.data.object as Stripe.Charge;
      if (esDeOtraApp(ch.metadata)) return { kind: 'ignore', reason: 'app_ajena' };
      if (!ch.id) return { kind: 'ignore', reason: 'charge_sin_id' };
      return {
        kind: 'reembolso',
        charge_id: ch.id,
        payment_intent_id: typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id ?? null,
        amount_refunded: ch.amount_refunded ?? 0,
        currency: ch.currency ?? 'mxn',
        customer_id: typeof ch.customer === 'string' ? ch.customer : ch.customer?.id ?? null,
        event_at
      };
    }

    case 'account.updated': {
      const acct = event.data.object as Stripe.Account;
      if (!acct.id) return { kind: 'ignore', reason: 'account_sin_id' };
      return {
        kind: 'cuenta-conectada',
        account_id: acct.id,
        charges_enabled: acct.charges_enabled === true,
        details_submitted: acct.details_submitted === true,
        payouts_enabled: acct.payouts_enabled === true,
        event_at
      };
    }

    default:
      return { kind: 'ignore', reason: `evento_no_manejado:${event.type}` };
  }
}

// ── Extracción de montos para payment_events (PURA) ─────────────────────────
export interface MontoEvento {
  monto_centavos: number;
  moneda: string;
  status: string;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
}

/**
 * Extrae el monto de un evento de Stripe para registrarlo en `payment_events`.
 *
 * SOLO reconoce los dos eventos que representan UNA cobranza real en el flujo
 * activo (Elements): `invoice.paid` (suscripción: 1ª factura + renovaciones) y
 * `payment_intent.succeeded` (paquete de créditos, pago único). Deliberadamente
 * NO cuenta `checkout.session.completed` para no DUPLICAR el monto (Stripe emite
 * ambos por el mismo pago). Devuelve null para cualquier otro evento.
 */
export function extraerMontoDeEvento(event: Stripe.Event): MontoEvento | null {
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object as Stripe.PaymentIntent & { invoice?: string | { id: string } | null };
    if (typeof pi.amount !== 'number') return null;
    // Si el PI pagó una FACTURA de suscripción, el ingreso ya se cuenta por
    // `invoice.paid` — NO contarlo otra vez acá (evita duplicar el ingreso).
    // Solo se cuentan los PI sin factura: los paquetes (pago único).
    if (pi.invoice) return null;
    return {
      monto_centavos: pi.amount,
      moneda: pi.currency ?? 'mxn',
      status: 'succeeded',
      stripe_invoice_id: null,
      stripe_payment_intent_id: pi.id,
      stripe_subscription_id: null,
      stripe_customer_id: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null
    };
  }

  if (event.type === 'invoice.paid') {
    const inv = event.data.object as Stripe.Invoice & {
      subscription?: string | { id: string } | null;
      payment_intent?: string | { id: string } | null;
    };
    if (typeof inv.amount_paid !== 'number') return null;
    return {
      monto_centavos: inv.amount_paid,
      moneda: inv.currency ?? 'mxn',
      status: 'succeeded',
      stripe_invoice_id: inv.id ?? null,
      stripe_payment_intent_id:
        typeof inv.payment_intent === 'string' ? inv.payment_intent : inv.payment_intent?.id ?? null,
      stripe_subscription_id:
        typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null,
      stripe_customer_id: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null
    };
  }

  // Reembolso: se registra como `refunded` con el monto devuelto (positivo).
  // Los ingresos leen status='succeeded', así que no se netea solo: el admin lo
  // ve en el historial del miembro y en cobranza.
  if (event.type === 'charge.refunded') {
    const ch = event.data.object as Stripe.Charge;
    if (typeof ch.amount_refunded !== 'number' || ch.amount_refunded <= 0) return null;
    return {
      monto_centavos: ch.amount_refunded,
      moneda: ch.currency ?? 'mxn',
      status: 'refunded',
      stripe_invoice_id: (() => { const inv = (ch as unknown as { invoice?: string | { id?: string } | null }).invoice; return typeof inv === 'string' ? inv : inv?.id ?? null; })(),
      stripe_payment_intent_id: typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id ?? null,
      stripe_subscription_id: null,
      stripe_customer_id: typeof ch.customer === 'string' ? ch.customer : ch.customer?.id ?? null
    };
  }

  // Cobro fallido: se registra como `failed` con el monto que se intentó cobrar
  // (amount_due). NO suma a ingresos (esos leen status='succeeded'), pero le da
  // ojos a la cobranza/dunning en el admin.
  if (event.type === 'invoice.payment_failed') {
    const inv = event.data.object as Stripe.Invoice & {
      subscription?: string | { id: string } | null;
      payment_intent?: string | { id: string } | null;
    };
    const monto = typeof inv.amount_due === 'number' ? inv.amount_due : inv.amount_remaining;
    if (typeof monto !== 'number') return null;
    return {
      monto_centavos: monto,
      moneda: inv.currency ?? 'mxn',
      status: 'failed',
      stripe_invoice_id: inv.id ?? null,
      stripe_payment_intent_id:
        typeof inv.payment_intent === 'string' ? inv.payment_intent : inv.payment_intent?.id ?? null,
      stripe_subscription_id:
        typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id ?? null,
      stripe_customer_id: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null
    };
  }

  return null;
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

/**
 * Idempotency key de `prices.create` para el precio recurrente de un plan.
 *
 * Stripe exige que una misma key se use SIEMPRE con los mismos parámetros: si el
 * admin editaba el precio o el nombre del plan, la key vieja (que solo llevaba
 * el id del plan) chocaba con los parámetros nuevos → 400 durante 24 h → nadie
 * podía suscribirse a ese plan. La key ahora es un hash de TODO lo que se manda.
 */
export function llavePrecio(p: {
  tierId: string;
  accountId: string;
  centavos: number;
  currency: string;
  nombre: string;
}): string {
  const huella = createHash('sha256')
    .update(JSON.stringify([p.tierId, p.accountId, p.centavos, p.currency.toLowerCase(), p.nombre]))
    .digest('hex')
    .slice(0, 40);
  return `ekko_price_${huella}`;
}
