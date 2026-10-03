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
      /** PKG-01H: identidad de negocio. Un PI aplica invitados como máximo una vez. */
      payment_intent_id: string;
      /** Lo cobrado de verdad (amount_received; si no viene, amount). */
      monto_centavos: number;
      moneda: string;
      /** Snapshot del precio con el que EKKO creó el PI; null si el PI no lo trae (anterior a 01H). */
      precio_unitario_centavos: number | null;
      /** tenant que EKKO puso en la metadata (se coteja; no es autoridad). */
      tenant_id_metadata: string | null;
      /**
       * Momento económico del pago: `created` del evento payment_intent.succeeded.
       * Stripe emite ese evento una vez por PI al pasar a succeeded y una
       * re-entrega conserva el mismo `created`; la RPC fija la primera evaluación.
       */
      event_at: string;
    }
  | {
      // PKG-01G · Reversal con identidad propia: un objeto Refund (re_…) o
      // Dispute (dp_…). Se registra como evidencia durable + revisión humana.
      // NUNCA muta créditos, membresía, cuenta, tier, reservas ni suscripción
      // (D7=A, D8=A).
      kind: 'reversal';
      tipo: 'reembolso' | 'disputa';
      object_id: string;
      charge_id: string;
      payment_intent_id: string | null;
      amount: number;
      currency: string;
      estado: string;
      motivo: string | null;
      object_created_at: string | null;
      event_at: string;
    }
  | {
      // PKG-01G · charge.refunded trae `amount_refunded` ACUMULADO: no es monto
      // de un reembolso. Solo sirve para reconciliar contra los Refund registrados.
      kind: 'reconciliar-reembolso';
      charge_id: string;
      amount_refunded: number;
      event_at: string;
    }
  | {
      // PKG-01G · Connect: el estudio desautorizó la plataforma. Afecta la
      // capacidad de cobro del ESTUDIO, nunca el derecho de un miembro.
      kind: 'cuenta-desautorizada';
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
  | { kind: 'ignore'; reason: string }
  | {
      // PKG-01A: el evento es de EKKO e implica dinero, pero trae datos que no
      // permiten producir el efecto (sesión/PI sin usuario o plan). NO es un
      // ignore: se cobró y no se puede dar el derecho → revisión humana.
      kind: 'revision';
      motivo: string;
    };

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
 * Forma de factura que EKKO puede recibir. Con la API fijada (`2025-08-27.basil`,
 * SDK 18.x) la suscripción vive en `parent.subscription_details.subscription` y el
 * PaymentIntent en `payments.data[].payment.payment_intent`; las versiones
 * anteriores los traían en `invoice.subscription` / `invoice.payment_intent`. Se
 * aceptan ambas formas (F2 · R1).
 */
export type FacturaCompat = {
  subscription?: string | { id: string } | null;
  payment_intent?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null; metadata?: { app?: string } | null } | null } | null;
  subscription_details?: { metadata?: { app?: string } | null } | null;
  payments?: { data?: Array<{ payment?: { type?: string; payment_intent?: string | { id: string } | null } | null }> } | null;
};

const idDe = (ref: string | { id: string } | null | undefined): string | null =>
  typeof ref === 'string' ? ref : ref?.id ?? null;

/** Id de la suscripción de una factura (legacy o basil). null si no la tiene. */
export function suscripcionDeFactura(inv: FacturaCompat): string | null {
  return idDe(inv.subscription) ?? idDe(inv.parent?.subscription_details?.subscription);
}

/** Id del PaymentIntent de una factura (legacy o basil). */
export function paymentIntentDeFactura(inv: FacturaCompat): string | null {
  const legacy = idDe(inv.payment_intent);
  if (legacy) return legacy;
  const pago = inv.payments?.data?.find((p) => p.payment?.type === 'payment_intent' || p.payment?.payment_intent);
  return idDe(pago?.payment?.payment_intent);
}

/** Metadata de la suscripción que viaja en la factura (basil o legacy). */
export function metadataSuscripcionDeFactura(inv: FacturaCompat): { app?: string } | null | undefined {
  return inv.parent?.subscription_details?.metadata ?? inv.subscription_details?.metadata;
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
      // PKG-01B (C17) · NO FINANCIAL SUCCESS → NO ENTITLEMENT SUCCESS.
      // `completed` NO significa pagado: con un método de notificación diferida
      // la sesión termina con payment_status='unpaid'. Solo 'paid' activa.
      //   paid                → activar (idempotente con el evento financiero hermano).
      //   unpaid              → ignore: el dinero, si llega, entra por
      //                         payment_intent.succeeded (misma referencia = PI) o
      //                         invoice.paid subscription_create (mismo sub id).
      //   no_payment_required → revision: EKKO no vende nada sin cobro por Stripe
      //                         (sin trials ni anclas); si aparece, alguien lo mire.
      //   ausente/otro        → revision (fail-safe).
      const payment_status = (s as { payment_status?: string }).payment_status;
      if (payment_status === 'unpaid') {
        return { kind: 'ignore', reason: `checkout_sin_pagar:${s.mode}` };
      }
      if (payment_status === 'no_payment_required') {
        return { kind: 'revision', motivo: 'checkout_sin_cobro_requerido' };
      }
      if (payment_status !== 'paid') {
        return { kind: 'revision', motivo: 'checkout_payment_status_desconocido' };
      }
      if (!usuario_id || !tier_id || !customer_id) {
        // La sesión la creó EKKO (las de otras apps traen metadata.app) y se
        // completó: hay dinero sin destinatario claro. Nunca "ignorado".
        return { kind: 'revision', motivo: 'faltan_datos_en_session' };
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
      const inv = event.data.object as unknown as FacturaCompat & { billing_reason?: string };
      if (esDeOtraApp(metadataSuscripcionDeFactura(inv))) return { kind: 'ignore', reason: 'app_ajena' };
      const subscription_id = suscripcionDeFactura(inv);
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
          return { kind: 'revision', motivo: 'invitados_extra_sin_datos' };
        }
        const recibido = typeof pi.amount_received === 'number' && pi.amount_received > 0 ? pi.amount_received : pi.amount;
        if (!pi.id || typeof recibido !== 'number' || recibido <= 0) {
          return { kind: 'revision', motivo: 'invitados_extra_sin_datos' };
        }
        const precio = Number.parseInt(pi.metadata?.precio_unitario_centavos ?? '', 10);
        return {
          kind: 'invitados-extra',
          reserva_id,
          cantidad,
          usuario_id: pi.metadata?.usuario_id ?? null,
          payment_intent_id: pi.id,
          monto_centavos: recibido,
          moneda: pi.currency ?? 'mxn',
          precio_unitario_centavos: Number.isInteger(precio) && precio > 0 ? precio : null,
          tenant_id_metadata: pi.metadata?.tenant_id ?? null,
          event_at
        };
      }
      // Paquete pagado in-app (pago único con Elements). El metadata lo pusimos
      // en crear-pago-intent. (Los PI de suscripción no llevan este metadata.)
      const usuario_id = pi.metadata?.usuario_id;
      const tier_id = pi.metadata?.tier_id;
      const customer_id = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
      if (!usuario_id || !tier_id || !customer_id) {
        // Con metadata.app = ekko lo creó EKKO y se cobró: revisión. Sin app es
        // el PI de una factura de suscripción (lo maneja invoice.paid): ignore.
        return pi.metadata?.app === APP_ID
          ? { kind: 'revision', motivo: 'payment_intent_ekko_sin_datos' }
          : { kind: 'ignore', reason: 'payment_intent_sin_metadata' };
      }
      return { kind: 'activar', usuario_id, tier_id, subscription_id: null, customer_id, referencia: pi.id, event_at };
    }

    case 'charge.refunded': {
      const ch = event.data.object as Stripe.Charge;
      if (esDeOtraApp(ch.metadata)) return { kind: 'ignore', reason: 'app_ajena' };
      if (!ch.id) return { kind: 'ignore', reason: 'charge_sin_id' };
      return { kind: 'reconciliar-reembolso', charge_id: ch.id, amount_refunded: ch.amount_refunded ?? 0, event_at };
    }

    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed': {
      const rf = event.data.object as Stripe.Refund;
      if (esDeOtraApp(rf.metadata as { app?: string } | null)) return { kind: 'ignore', reason: 'app_ajena' };
      const charge_id = typeof rf.charge === 'string' ? rf.charge : rf.charge?.id ?? null;
      if (!rf.id || !charge_id) return { kind: 'revision', motivo: 'refund_sin_identidad' };
      if (typeof rf.amount !== 'number' || rf.amount <= 0) return { kind: 'revision', motivo: 'refund_sin_monto' };
      return {
        kind: 'reversal',
        tipo: 'reembolso',
        object_id: rf.id,
        charge_id,
        payment_intent_id: typeof rf.payment_intent === 'string' ? rf.payment_intent : rf.payment_intent?.id ?? null,
        amount: rf.amount,
        currency: rf.currency ?? 'mxn',
        estado: rf.status ?? 'pending',
        motivo: rf.reason ?? null,
        object_created_at: typeof rf.created === 'number' ? new Date(rf.created * 1000).toISOString() : null,
        event_at
      };
    }

    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated': {
      const dp = event.data.object as Stripe.Dispute;
      const charge_id = typeof dp.charge === 'string' ? dp.charge : dp.charge?.id ?? null;
      if (!dp.id || !charge_id) return { kind: 'revision', motivo: 'dispute_sin_identidad' };
      if (typeof dp.amount !== 'number' || dp.amount <= 0) return { kind: 'revision', motivo: 'dispute_sin_monto' };
      return {
        kind: 'reversal',
        tipo: 'disputa',
        object_id: dp.id,
        charge_id,
        payment_intent_id: typeof dp.payment_intent === 'string' ? dp.payment_intent : dp.payment_intent?.id ?? null,
        amount: dp.amount,
        currency: dp.currency ?? 'mxn',
        estado: dp.status,
        motivo: dp.reason ?? null,
        object_created_at: typeof dp.created === 'number' ? new Date(dp.created * 1000).toISOString() : null,
        event_at
      };
    }

    case 'account.application.deauthorized': {
      // `data.object` es la Application; la cuenta viene en `event.account`.
      return { kind: 'cuenta-desautorizada', event_at };
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
    // Legacy: el PI traía `invoice`. Basil ya no lo trae (la relación vive en la
    // factura), así que solo se cuentan los PI que EKKO creó: los que llevan
    // `metadata.app = 'ekko'` (paquetes e invitados extra). F2 · R1.
    if (pi.invoice) return null;
    if (pi.metadata?.app !== APP_ID) return null;
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
    const inv = event.data.object as Stripe.Invoice & FacturaCompat;
    if (typeof inv.amount_paid !== 'number') return null;
    return {
      monto_centavos: inv.amount_paid,
      moneda: inv.currency ?? 'mxn',
      status: 'succeeded',
      stripe_invoice_id: inv.id ?? null,
      stripe_payment_intent_id: paymentIntentDeFactura(inv),
      stripe_subscription_id: suscripcionDeFactura(inv),
      stripe_customer_id: typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null
    };
  }

  // PKG-01G: los reembolsos YA NO entran al diario de cobranza. `charge.refunded`
  // trae un acumulado (sumarlo por evento duplicaba parciales); la evidencia
  // exacta vive en `reversales_pago` (un Refund = una fila, vía refund.*).

  // Cobro fallido: se registra como `failed` con el monto que se intentó cobrar
  // (amount_due). NO suma a ingresos (esos leen status='succeeded'), pero le da
  // ojos a la cobranza/dunning en el admin.
  if (event.type === 'invoice.payment_failed') {
    const inv = event.data.object as Stripe.Invoice & FacturaCompat;
    const monto = typeof inv.amount_due === 'number' ? inv.amount_due : inv.amount_remaining;
    if (typeof monto !== 'number') return null;
    return {
      monto_centavos: monto,
      moneda: inv.currency ?? 'mxn',
      status: 'failed',
      stripe_invoice_id: inv.id ?? null,
      stripe_payment_intent_id: paymentIntentDeFactura(inv),
      stripe_subscription_id: suscripcionDeFactura(inv),
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

// ── PKG-01A · Estado durable del evento (helpers PUROS) ──────────────────────

export type EstadoEventoWebhook = 'en_proceso' | 'procesado' | 'ignorado' | 'error_reintentable' | 'revision';

/**
 * Divergencia: el evento es de EKKO, implica dinero/derecho, y la entidad que
 * debía recibir el efecto no existe o no se puede reconciliar (membresía no
 * encontrada, suscripción sin metadata…). No se inventa nada, no se relaja R1:
 * el evento va a `revision` con evidencia. Siempre es un error PERMANENTE.
 */
export class DivergenciaWebhook extends Error {
  constructor(readonly motivo: string, detalle?: string) {
    super(detalle ? `${motivo}: ${detalle}` : motivo);
    this.name = 'DivergenciaWebhook';
  }
}

/** Error devuelto por un RPC de Supabase (conserva el código SQLSTATE para clasificarlo). */
export class ErrorRpcWebhook extends Error {
  readonly code: string | null;
  constructor(origen: string, err: { message?: string; code?: string | null } | null | undefined) {
    super(`${origen}: ${err?.message ?? 'error desconocido'}`);
    this.name = 'ErrorRpcWebhook';
    this.code = err?.code ?? null;
  }
}

/**
 * ¿Reintentar puede arreglarlo? Decide entre `error_reintentable` (5xx, Stripe
 * reintenta) y `revision` (permanente). Ante duda → transitorio (D-01A-1: la
 * revisión nunca es un catch-all; los intentos agotados la alcanzan igual).
 *
 * Permanentes: divergencias; excepciones de negocio de nuestros RPC (EKKO_*,
 * SQLSTATE P0001); violaciones de integridad/datos (23xxx, 22xxx); peticiones
 * inválidas a Stripe (StripeInvalidRequestError: resource_missing, etc.).
 */
export function clasificarError(err: unknown): 'permanente' | 'transitorio' {
  if (err instanceof DivergenciaWebhook) return 'permanente';
  const e = err as { name?: string; type?: string; code?: string | null; message?: string } | null;
  if (!e || typeof e !== 'object') return 'transitorio';
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'P0001' || code.startsWith('23') || code.startsWith('22')) return 'permanente';
  if (typeof e.message === 'string' && /\bEKKO_[A-Z_]+/.test(e.message)) return 'permanente';
  const tipoStripe = e.type ?? e.name ?? '';
  if (tipoStripe === 'StripeInvalidRequestError') return 'permanente';
  return 'transitorio';
}

/**
 * ¿Re-ejecutar la acción tras un crash a medias es seguro? activar (por
 * suscripción/referencia), sync (guardia de orden), reembolso (solo aviso) y
 * cuenta-conectada (update) son idempotentes. `registrar_invitados_extra_pagados`
 * NO: un reclamo de lease vencido con esa acción va a revisión, no se repite.
 */
export function accionIdempotente(kind: EventoClasificado['kind']): boolean {
  // PKG-01H: invitados-extra pasó a ser idempotente por PaymentIntent
  // (aplicar_invitados_extra_pago): re-ejecutarla no vuelve a sumar.
  void kind;
  return true;
}

const METADATA_EKKO = ['app', 'usuario_id', 'tier_id', 'reserva_id', 'cantidad', 'tipo', 'precio_unitario_centavos', 'tenant_id'] as const;

const idODef = (v: unknown): string | null =>
  typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null;

/**
 * Resumen mínimo del evento para `stripe_webhook_events.resumen`: ids y montos,
 * NUNCA correo/nombre/dirección. Con esto se localiza el objeto en el dashboard
 * de Stripe y se reenvía el evento tras corregir la causa.
 */
export function resumenEvento(event: Stripe.Event): Record<string, unknown> {
  const o = (event.data?.object ?? {}) as unknown as Record<string, unknown>;
  const parent = o.parent as { subscription_details?: { subscription?: unknown; metadata?: Record<string, unknown> } } | undefined;
  const metaOrigen = (o.metadata ?? parent?.subscription_details?.metadata ?? {}) as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  for (const k of METADATA_EKKO) if (metaOrigen[k] !== undefined) metadata[k] = metaOrigen[k];

  const resumen: Record<string, unknown> = {
    objeto: o.object ?? null,
    id: idODef(o.id),
    subscription: idODef(o.subscription) ?? idODef(parent?.subscription_details?.subscription),
    customer: idODef(o.customer),
    invoice: idODef(o.invoice),
    payment_intent: idODef(o.payment_intent),
    charge: o.object === 'charge' ? idODef(o.id) : idODef(o.latest_charge) ?? idODef(o.charge),
    monto: o.amount_paid ?? o.amount_due ?? o.amount_refunded ?? o.amount_total ?? o.amount ?? null,
    currency: o.currency ?? null,
    status: o.status ?? null,
    // PKG-01G: Refund/Dispute: razón del proveedor (código, no texto libre).
    reason: typeof o.reason === 'string' ? o.reason : null,
    // PKG-01B: evidencia de si la sesión de Checkout estaba pagada al completarse.
    payment_status: o.payment_status ?? null,
    billing_reason: o.billing_reason ?? null,
    mode: o.mode ?? null,
    metadata
  };
  for (const k of Object.keys(resumen)) if (resumen[k] === null || resumen[k] === undefined) delete resumen[k];
  return resumen;
}

/** Claves con PII que Stripe incluye en facturas, sesiones, PI, charges y customers. */
const CLAVES_PII_PAYLOAD = new Set([
  'customer_email', 'customer_name', 'customer_address', 'customer_phone', 'customer_shipping',
  'customer_tax_ids', 'customer_details', 'receipt_email', 'billing_details', 'shipping',
  'email', 'name', 'phone', 'address', 'account_name', 'account_holder_name', 'tax_ids',
  'individual', 'company', 'support_email', 'support_phone', 'support_address'
]);

/**
 * Copia del evento sin PII para `payment_events.raw_payload` (evidencia para
 * identificación, conciliación, diagnóstico y atribución; nada más). Solo para
 * eventos NUEVOS: las filas históricas no se tocan (PKG-01A).
 */
export function redactarPayload<T>(valor: T, profundidad = 0): T {
  if (valor === null || typeof valor !== 'object' || profundidad > 12) return valor;
  if (Array.isArray(valor)) return valor.map((v) => redactarPayload(v, profundidad + 1)) as unknown as T;
  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
    if (CLAVES_PII_PAYLOAD.has(k)) {
      salida[k] = v === null || v === undefined ? v : '[redactado]';
    } else {
      salida[k] = redactarPayload(v, profundidad + 1);
    }
  }
  return salida as T;
}
