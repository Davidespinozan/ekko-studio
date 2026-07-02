import { describe, it, expect } from 'vitest';
import {
  mapStripeStatus,
  periodoFinFromSubscription,
  clasificarEvento,
  extraerMontoDeEvento
} from '../../netlify/functions/_lib/stripe';

/**
 * Mappers PUROS del billing de Stripe. Son la lógica central del webhook
 * (qué hacer ante cada evento) y se testean sin tocar Stripe ni la DB.
 */

type Ev = Parameters<typeof clasificarEvento>[0];
const ev = (type: string, object: unknown, created = 1_700_000_000): Ev =>
  ({ id: 'evt_1', type, created, data: { object } }) as unknown as Ev;

describe('mapStripeStatus', () => {
  it('active/trialing → activa', () => {
    expect(mapStripeStatus('active')).toBe('activa');
    expect(mapStripeStatus('trialing')).toBe('activa');
  });
  it('past_due → past_due (gracia, mantiene acceso)', () => {
    expect(mapStripeStatus('past_due')).toBe('past_due');
  });
  it('canceled/unpaid/incomplete_expired → cancelada', () => {
    expect(mapStripeStatus('canceled')).toBe('cancelada');
    expect(mapStripeStatus('unpaid')).toBe('cancelada');
    expect(mapStripeStatus('incomplete_expired')).toBe('cancelada');
  });
  it('estados transitorios → null (no tocar la membresía)', () => {
    expect(mapStripeStatus('incomplete')).toBeNull();
    expect(mapStripeStatus('paused')).toBeNull();
  });
});

describe('periodoFinFromSubscription', () => {
  it('lee current_period_end del top-level', () => {
    expect(periodoFinFromSubscription({ current_period_end: 1_700_000_000 }))
      .toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
  it('cae a los items (API "basil") si no está en top-level', () => {
    expect(periodoFinFromSubscription({ items: { data: [{ current_period_end: 1_700_000_000 }] } }))
      .toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
  it('sin dato → null', () => {
    expect(periodoFinFromSubscription({})).toBeNull();
  });
});

describe('clasificarEvento', () => {
  it('checkout.session.completed con metadata → activar', () => {
    const r = clasificarEvento(ev('checkout.session.completed', {
      mode: 'subscription',
      subscription: 'sub_1',
      customer: 'cus_1',
      metadata: { usuario_id: 'u1', tier_id: 't1' }
    }));
    expect(r.kind).toBe('activar');
    if (r.kind === 'activar') {
      expect(r.usuario_id).toBe('u1');
      expect(r.tier_id).toBe('t1');
      expect(r.subscription_id).toBe('sub_1');
      expect(r.customer_id).toBe('cus_1');
    }
  });

  it('checkout.session.completed mode payment (paquete) → activar con subscription_id null', () => {
    const r = clasificarEvento(ev('checkout.session.completed', {
      mode: 'payment',
      subscription: null,
      customer: 'cus_1',
      metadata: { usuario_id: 'u1', tier_id: 't1' }
    }));
    expect(r.kind).toBe('activar');
    if (r.kind === 'activar') {
      expect(r.subscription_id).toBeNull();
      expect(r.customer_id).toBe('cus_1');
    }
  });

  it('checkout.session.completed sin metadata → ignore', () => {
    const r = clasificarEvento(ev('checkout.session.completed', {
      mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: {}
    }));
    expect(r.kind).toBe('ignore');
  });

  it('checkout en modo setup (ni pago ni suscripción) → ignore', () => {
    const r = clasificarEvento(ev('checkout.session.completed', {
      mode: 'setup', subscription: null, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' }
    }));
    expect(r.kind).toBe('ignore');
  });

  it('customer.subscription.updated activa → sync activa', () => {
    const r = clasificarEvento(ev('customer.subscription.updated', {
      id: 'sub_1', status: 'active', cancel_at_period_end: false, current_period_end: 1_700_000_000
    }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(r.estado).toBe('activa');
      expect(r.subscription_id).toBe('sub_1');
      expect(r.cancel_at_period_end).toBe(false);
      expect(r.periodo_fin).not.toBeNull();
    }
  });

  it('customer.subscription.deleted → sync cancelada', () => {
    const r = clasificarEvento(ev('customer.subscription.deleted', { id: 'sub_1', status: 'canceled' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') expect(r.estado).toBe('cancelada');
  });

  it('subscription.updated con status transitorio → ignore', () => {
    const r = clasificarEvento(ev('customer.subscription.updated', { id: 'sub_1', status: 'incomplete' }));
    expect(r.kind).toBe('ignore');
  });

  it('invoice.payment_failed → sync past_due', () => {
    const r = clasificarEvento(ev('invoice.payment_failed', { subscription: 'sub_1' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') expect(r.estado).toBe('past_due');
  });

  it('invoice.paid (renovación) → sync activa', () => {
    const r = clasificarEvento(ev('invoice.paid', { subscription: 'sub_1', billing_reason: 'subscription_cycle' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') expect(r.estado).toBe('activa');
  });

  it('invoice.paid 1ª factura (subscription_create) → activar-sub', () => {
    const r = clasificarEvento(ev('invoice.paid', { subscription: 'sub_1', billing_reason: 'subscription_create' }));
    expect(r.kind).toBe('activar-sub');
    if (r.kind === 'activar-sub') expect(r.subscription_id).toBe('sub_1');
  });

  it('payment_intent.succeeded con metadata (paquete) → activar sin suscripción', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', {
      customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' }
    }));
    expect(r.kind).toBe('activar');
    if (r.kind === 'activar') expect(r.subscription_id).toBeNull();
  });

  it('payment_intent.succeeded sin metadata → ignore', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', { customer: 'cus_1', metadata: {} }));
    expect(r.kind).toBe('ignore');
  });

  it('evento no manejado → ignore', () => {
    const r = clasificarEvento(ev('customer.created', { id: 'cus_1' }));
    expect(r.kind).toBe('ignore');
  });

  it('event_at se deriva de event.created', () => {
    const r = clasificarEvento(ev('invoice.paid', { subscription: 'sub_1' }, 1_650_000_000));
    if (r.kind === 'sync') {
      expect(r.event_at).toBe(new Date(1_650_000_000 * 1000).toISOString());
    }
  });
});

describe('extraerMontoDeEvento', () => {
  it('payment_intent.succeeded → monto del PI', () => {
    const r = extraerMontoDeEvento(
      ev('payment_intent.succeeded', { id: 'pi_1', amount: 45000, currency: 'mxn', customer: 'cus_1' })
    );
    expect(r).toEqual({
      monto_centavos: 45000,
      moneda: 'mxn',
      status: 'succeeded',
      stripe_invoice_id: null,
      stripe_payment_intent_id: 'pi_1',
      stripe_subscription_id: null,
      stripe_customer_id: 'cus_1'
    });
  });

  it('invoice.paid → monto de amount_paid + ids', () => {
    const r = extraerMontoDeEvento(
      ev('invoice.paid', { id: 'in_1', amount_paid: 29900, currency: 'mxn', subscription: 'sub_9', customer: 'cus_2', payment_intent: 'pi_9' })
    );
    expect(r?.monto_centavos).toBe(29900);
    expect(r?.stripe_subscription_id).toBe('sub_9');
    expect(r?.stripe_invoice_id).toBe('in_1');
    expect(r?.stripe_payment_intent_id).toBe('pi_9');
  });

  it('NO cuenta checkout.session.completed (evitar doble conteo)', () => {
    expect(
      extraerMontoDeEvento(ev('checkout.session.completed', { amount_total: 45000, currency: 'mxn' }))
    ).toBeNull();
  });

  it('invoice.payment_failed → null (no es cobranza exitosa)', () => {
    expect(extraerMontoDeEvento(ev('invoice.payment_failed', { amount_paid: 0 }))).toBeNull();
  });

  it('subscription.updated → null', () => {
    expect(extraerMontoDeEvento(ev('customer.subscription.updated', { id: 'sub_1' }))).toBeNull();
  });
});
