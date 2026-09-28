import { describe, it, expect } from 'vitest';
import {
  clasificarEvento,
  extraerMontoDeEvento,
  suscripcionDeFactura,
  paymentIntentDeFactura,
  metadataSuscripcionDeFactura,
  periodoFinFromSubscription,
  type FacturaCompat
} from '../../netlify/functions/_lib/stripe';

/**
 * PKG-00G (C25) — Fixtures con la forma REAL que Stripe envía hoy a EKKO.
 *
 * La app fija la API `2025-08-27.basil`, pero el endpoint del webhook no fija
 * versión y hereda la de la cuenta (compartida): los eventos reales llegan en
 * `2026-04-22.dahlia`. Estos fixtures copian la ESTRUCTURA observada en los
 * eventos guardados en `payment_events` (solo nombres de campos y tipos; todos
 * los valores son sintéticos, sin PII ni ids reales):
 *
 * - invoice.*: SIN `subscription`, SIN `payment_intent`, SIN `payments`; la
 *   suscripción y su metadata viajan en `parent.subscription_details`.
 * - payment_intent.succeeded: SIN `invoice`; `metadata.app` decide si es de EKKO.
 *
 * Si alguna de estas pruebas falla, el código productivo dejó de entender lo
 * que producción recibe. No adaptar los fixtures: reportar la regresión.
 */

type Ev = Parameters<typeof clasificarEvento>[0];
const ev = (type: string, object: unknown, created = 1_780_000_000): Ev =>
  ({ id: 'evt_dahlia', type, created, data: { object } }) as unknown as Ev;

const CLAVES_LEGACY_QUE_DAHLIA_NO_TRAE = ['subscription', 'payment_intent', 'payments'] as const;

/** Factura dahlia (forma observada en producción). Valores sintéticos. */
function facturaDahlia(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'in_dahlia_1',
    object: 'invoice',
    livemode: true,
    status: 'paid',
    billing_reason: 'subscription_create',
    amount_due: 85000,
    amount_paid: 85000,
    amount_remaining: 0,
    total: 85000,
    currency: 'mxn',
    customer: 'cus_dahlia_1',
    attempt_count: 1,
    next_payment_attempt: null,
    period_start: 1_780_000_000,
    period_end: 1_782_592_000,
    metadata: {},
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_dahlia_1',
        metadata: { app: 'ekko', usuario_id: 'usuario_1', tier_id: 'tier_1' }
      }
    },
    lines: {
      object: 'list',
      data: [
        {
          amount: 85000,
          currency: 'mxn',
          period: { start: 1_780_000_000, end: 1_782_592_000 },
          parent: { type: 'subscription_item_details' },
          pricing: { type: 'price_details' }
        }
      ]
    },
    ...over
  };
}

/** PaymentIntent dahlia (forma observada). Valores sintéticos. */
function paymentIntentDahlia(metadata: Record<string, string> | undefined) {
  return {
    id: 'pi_dahlia_1',
    object: 'payment_intent',
    livemode: true,
    status: 'succeeded',
    amount: 25000,
    amount_received: 25000,
    currency: 'mxn',
    customer: 'cus_dahlia_2',
    latest_charge: 'ch_dahlia_1',
    metadata
  };
}

describe('fixtures dahlia: forma fiel a producción', () => {
  it('la factura dahlia NO trae los campos legacy que el código aceptaba antes', () => {
    const inv = facturaDahlia();
    for (const k of CLAVES_LEGACY_QUE_DAHLIA_NO_TRAE) expect(inv).not.toHaveProperty(k);
    expect(inv.parent.type).toBe('subscription_details');
  });

  it('el PaymentIntent dahlia NO trae `invoice`', () => {
    expect(paymentIntentDahlia({ app: 'ekko' })).not.toHaveProperty('invoice');
  });
});

describe('helpers de factura con forma dahlia', () => {
  it('suscripcionDeFactura lee parent.subscription_details.subscription', () => {
    expect(suscripcionDeFactura(facturaDahlia() as FacturaCompat)).toBe('sub_dahlia_1');
  });

  it('paymentIntentDeFactura → null (dahlia no incluye el PaymentIntent en la factura)', () => {
    expect(paymentIntentDeFactura(facturaDahlia() as FacturaCompat)).toBeNull();
  });

  it('metadataSuscripcionDeFactura lee la metadata de parent.subscription_details', () => {
    const m = metadataSuscripcionDeFactura(facturaDahlia() as FacturaCompat);
    expect(m?.app).toBe('ekko');
  });
});

describe('clasificarEvento con eventos dahlia', () => {
  it('invoice.paid de alta (subscription_create) → activar-sub con la suscripción del parent', () => {
    const r = clasificarEvento(ev('invoice.paid', facturaDahlia()));
    expect(r).toMatchObject({ kind: 'activar-sub', subscription_id: 'sub_dahlia_1' });
  });

  it('invoice.paid de renovación (subscription_cycle) → sync activa', () => {
    const r = clasificarEvento(ev('invoice.paid', facturaDahlia({ billing_reason: 'subscription_cycle' })));
    expect(r).toMatchObject({ kind: 'sync', subscription_id: 'sub_dahlia_1', estado: 'activa' });
  });

  it('invoice.payment_failed → sync past_due', () => {
    const r = clasificarEvento(
      ev('invoice.payment_failed', facturaDahlia({
        status: 'open', billing_reason: 'subscription_cycle', amount_paid: 0, amount_remaining: 85000, attempt_count: 2, next_payment_attempt: 1_780_300_000
      }))
    );
    expect(r).toMatchObject({ kind: 'sync', subscription_id: 'sub_dahlia_1', estado: 'past_due' });
  });

  it('factura de OTRA app en el parent → ignore (app_ajena)', () => {
    const inv = facturaDahlia({
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_x', metadata: { app: 'hogar' } } }
    });
    expect(clasificarEvento(ev('invoice.paid', inv))).toMatchObject({ kind: 'ignore', reason: 'app_ajena' });
  });

  it('payment_intent.succeeded de otra app (forma observada: metadata {app, user_id}) → ignore', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', paymentIntentDahlia({ app: 'hogar', user_id: 'x' })));
    expect(r).toMatchObject({ kind: 'ignore', reason: 'app_ajena' });
  });
});

describe('extraerMontoDeEvento con eventos dahlia', () => {
  it('invoice.paid → amount_paid, suscripción del parent y PaymentIntent null', () => {
    const r = extraerMontoDeEvento(ev('invoice.paid', facturaDahlia()));
    expect(r).toEqual({
      monto_centavos: 85000,
      moneda: 'mxn',
      status: 'succeeded',
      stripe_invoice_id: 'in_dahlia_1',
      stripe_payment_intent_id: null,
      stripe_subscription_id: 'sub_dahlia_1',
      stripe_customer_id: 'cus_dahlia_1'
    });
  });

  it('invoice.payment_failed → failed con amount_due y suscripción del parent', () => {
    const r = extraerMontoDeEvento(
      ev('invoice.payment_failed', facturaDahlia({ status: 'open', billing_reason: 'subscription_cycle', amount_paid: 0, amount_remaining: 85000 }))
    );
    expect(r).toMatchObject({ status: 'failed', monto_centavos: 85000, stripe_subscription_id: 'sub_dahlia_1', stripe_payment_intent_id: null });
  });

  it('payment_intent.succeeded de EKKO (sin `invoice`, metadata.app=ekko) → succeeded', () => {
    const r = extraerMontoDeEvento(ev('payment_intent.succeeded', paymentIntentDahlia({ app: 'ekko', usuario_id: 'usuario_1', tier_id: 'tier_1' })));
    expect(r).toMatchObject({ status: 'succeeded', monto_centavos: 25000, stripe_payment_intent_id: 'pi_dahlia_1', stripe_customer_id: 'cus_dahlia_2', stripe_invoice_id: null });
  });

  it('payment_intent.succeeded de una factura de suscripción (sin metadata.app) → null, no se cuenta dos veces', () => {
    expect(extraerMontoDeEvento(ev('payment_intent.succeeded', paymentIntentDahlia(undefined)))).toBeNull();
    expect(extraerMontoDeEvento(ev('payment_intent.succeeded', paymentIntentDahlia({})))).toBeNull();
  });

  it('payment_intent.succeeded de otra app (metadata {app, user_id}) → null', () => {
    expect(extraerMontoDeEvento(ev('payment_intent.succeeded', paymentIntentDahlia({ app: 'hogar', user_id: 'x' })))).toBeNull();
  });
});

describe('periodoFinFromSubscription con la suscripción que devuelve la API fijada (basil/dahlia)', () => {
  it('sin current_period_end en el top-level → lo toma del primer item', () => {
    const sub = {
      id: 'sub_dahlia_1',
      object: 'subscription',
      status: 'active',
      items: { object: 'list', data: [{ id: 'si_1', current_period_start: 1_780_000_000, current_period_end: 1_782_592_000 }] }
    };
    expect(sub).not.toHaveProperty('current_period_end');
    expect(periodoFinFromSubscription(sub)).toBe(new Date(1_782_592_000 * 1000).toISOString());
  });

  it('con items vacíos → null (no inventa un periodo)', () => {
    expect(periodoFinFromSubscription({ id: 'sub_x', items: { data: [] } })).toBeNull();
  });
});
