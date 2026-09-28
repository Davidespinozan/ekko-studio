import { describe, it, expect } from 'vitest';
import {
  mapStripeStatus,
  periodoFinFromSubscription,
  clasificarEvento,
  extraerMontoDeEvento,
  suscripcionDeFactura,
  paymentIntentDeFactura,
  esDeOtraApp,
  llavePrecio
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
      payment_status: 'paid', mode: 'subscription',
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
      payment_status: 'paid', mode: 'payment',
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

  it('checkout.session.completed sin metadata → revision (PKG-01A: se cobró y no hay a quién dar el derecho; antes era ignore silencioso)', () => {
    const r = clasificarEvento(ev('checkout.session.completed', {
      payment_status: 'paid', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: {}
    }));
    expect(r).toEqual({ kind: 'revision', motivo: 'faltan_datos_en_session' });
  });

  it('checkout en modo setup (ni pago ni suscripción) → ignore', () => {
    const r = clasificarEvento(ev('checkout.session.completed', {
      payment_status: 'paid', mode: 'setup', subscription: null, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' }
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

  it('payment_intent.succeeded tipo=invitados_extra → invitados-extra con reserva y cantidad', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', {
      customer: 'cus_1',
      metadata: { app: 'ekko', tipo: 'invitados_extra', reserva_id: 'res_1', cantidad: '3', usuario_id: 'u1' }
    }));
    expect(r.kind).toBe('invitados-extra');
    if (r.kind === 'invitados-extra') {
      expect(r.reserva_id).toBe('res_1');
      expect(r.cantidad).toBe(3);
      expect(r.usuario_id).toBe('u1');
    }
  });

  it('invitados_extra sin reserva_id / cantidad inválida → revision (PKG-01A: pago de EKKO sin datos para aplicarlo)', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', {
      customer: 'cus_1', metadata: { tipo: 'invitados_extra', cantidad: '0' }
    }));
    expect(r).toEqual({ kind: 'revision', motivo: 'invitados_extra_sin_datos' });
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
      ev('payment_intent.succeeded', { id: 'pi_1', amount: 45000, currency: 'mxn', customer: 'cus_1', metadata: { app: 'ekko' } })
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

  it('payment_intent.succeeded CON invoice → null (ya lo cuenta invoice.paid, no duplicar)', () => {
    expect(
      extraerMontoDeEvento(ev('payment_intent.succeeded', { id: 'pi_1', amount: 29900, currency: 'mxn', invoice: 'in_1', customer: 'cus_1' }))
    ).toBeNull();
  });

  it('NO cuenta checkout.session.completed (evitar doble conteo)', () => {
    expect(
      extraerMontoDeEvento(ev('checkout.session.completed', { amount_total: 45000, currency: 'mxn' }))
    ).toBeNull();
  });

  it('invoice.payment_failed → registro failed con el monto intentado (amount_due)', () => {
    const r = extraerMontoDeEvento(
      ev('invoice.payment_failed', { id: 'in_2', amount_due: 29900, currency: 'mxn', subscription: 'sub_9', customer: 'cus_2' })
    );
    expect(r?.status).toBe('failed');
    expect(r?.monto_centavos).toBe(29900);
    expect(r?.stripe_subscription_id).toBe('sub_9');
  });

  it('subscription.updated → null', () => {
    expect(extraerMontoDeEvento(ev('customer.subscription.updated', { id: 'sub_1' }))).toBeNull();
  });
});

describe('cuenta Stripe compartida — filtro por metadata.app', () => {
  it('esDeOtraApp: solo rechaza apps distintas; sin metadata se asume propia', () => {
    expect(esDeOtraApp({ app: 'sala' })).toBe(true);
    expect(esDeOtraApp({ app: 'ekko' })).toBe(false);
    expect(esDeOtraApp({})).toBe(false);
    expect(esDeOtraApp(null)).toBe(false);
    expect(esDeOtraApp(undefined)).toBe(false);
  });

  it('checkout / subscription / payment_intent de otra app → ignore app_ajena', () => {
    const casos = [
      ev('checkout.session.completed', { payment_status: 'paid', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { app: 'sala', usuario_id: 'u1', tier_id: 't1' } }),
      ev('customer.subscription.updated', { id: 'sub_1', status: 'active', metadata: { app: 'sala' } }),
      ev('customer.subscription.deleted', { id: 'sub_1', status: 'canceled', metadata: { app: 'hsc' } }),
      ev('payment_intent.succeeded', { customer: 'cus_1', metadata: { app: 'sala', usuario_id: 'u1', tier_id: 't1' } })
    ];
    for (const e of casos) {
      expect(clasificarEvento(e)).toEqual({ kind: 'ignore', reason: 'app_ajena' });
    }
  });

  it('invoice de otra app (metadata en parent.subscription_details) → ignore app_ajena', () => {
    const r = clasificarEvento(ev('invoice.paid', {
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: 'sub_1', metadata: { app: 'sala' } } }
    }));
    expect(r).toEqual({ kind: 'ignore', reason: 'app_ajena' });
  });

  it('objetos con app=ekko o sin metadata se procesan normal', () => {
    const propio = clasificarEvento(ev('customer.subscription.updated', { id: 'sub_1', status: 'active', metadata: { app: 'ekko' } }));
    expect(propio.kind).toBe('sync');
    const sinMeta = clasificarEvento(ev('invoice.paid', { subscription: 'sub_1', billing_reason: 'subscription_cycle' }));
    expect(sinMeta.kind).toBe('sync');
  });
});

describe('account.updated (Connect)', () => {
  it('→ cuenta-conectada con los flags del gate de cobro', () => {
    const r = clasificarEvento(ev('account.updated', {
      id: 'acct_1', charges_enabled: true, details_submitted: true, payouts_enabled: false
    }));
    expect(r).toEqual({
      kind: 'cuenta-conectada',
      account_id: 'acct_1',
      charges_enabled: true,
      details_submitted: true,
      payouts_enabled: false,
      event_at: new Date(1_700_000_000 * 1000).toISOString()
    });
  });

  it('flags ausentes → false (no se activa el cobro por accidente)', () => {
    const r = clasificarEvento(ev('account.updated', { id: 'acct_1' }));
    expect(r).toMatchObject({ kind: 'cuenta-conectada', charges_enabled: false, details_submitted: false });
  });
});

describe('charge.refunded (reembolsos)', () => {
  it('clasifica como reembolso con el monto devuelto y el PI original', () => {
    const r = clasificarEvento(ev('charge.refunded', {
      id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 85000, currency: 'mxn', customer: 'cus_1', metadata: { app: 'ekko' }
    }));
    expect(r).toMatchObject({ kind: 'reembolso', charge_id: 'ch_1', payment_intent_id: 'pi_1', amount_refunded: 85000, currency: 'mxn', customer_id: 'cus_1' });
  });

  it('de otra app → ignore', () => {
    expect(clasificarEvento(ev('charge.refunded', { id: 'ch_1', metadata: { app: 'sala' } }))).toEqual({ kind: 'ignore', reason: 'app_ajena' });
  });

  it('extraerMontoDeEvento lo registra como refunded (positivo) y no como ingreso', () => {
    const m = extraerMontoDeEvento(ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 85000, currency: 'mxn', customer: 'cus_1' }));
    expect(m).toMatchObject({ status: 'refunded', monto_centavos: 85000, stripe_payment_intent_id: 'pi_1', stripe_customer_id: 'cus_1' });
    expect(extraerMontoDeEvento(ev('charge.refunded', { id: 'ch_2', amount_refunded: 0 }))).toBeNull();
  });
});

describe('pause_collection (membresía pausada)', () => {
  it('subscription.updated con pause_collection → sync pausada aunque Stripe diga active', () => {
    const r = clasificarEvento(ev('customer.subscription.updated', { id: 'sub_1', status: 'active', pause_collection: { behavior: 'void' }, metadata: { app: 'ekko' } }));
    expect(r).toMatchObject({ kind: 'sync', estado: 'pausada' });
  });
  it('sin pause_collection → activa', () => {
    const r = clasificarEvento(ev('customer.subscription.updated', { id: 'sub_1', status: 'active', pause_collection: null }));
    expect(r).toMatchObject({ kind: 'sync', estado: 'activa' });
  });
});

describe('llavePrecio — idempotencyKey de prices.create', () => {
  const base = { tierId: 'tier-1', accountId: 'acct_1', centavos: 85000, currency: 'mxn', nombre: 'Esencial' };

  it('mismos parámetros → misma key (un doble clic no crea dos precios)', () => {
    expect(llavePrecio(base)).toBe(llavePrecio({ ...base }));
    expect(llavePrecio(base)).toBe(llavePrecio({ ...base, currency: 'MXN' }));
  });

  it('si el admin cambia el PRECIO o el NOMBRE, la key cambia (antes: 400 de Stripe durante 24 h)', () => {
    expect(llavePrecio({ ...base, centavos: 90000 })).not.toBe(llavePrecio(base));
    expect(llavePrecio({ ...base, nombre: 'Esencial Plus' })).not.toBe(llavePrecio(base));
  });

  it('otro plan u otra cuenta conectada → otra key', () => {
    expect(llavePrecio({ ...base, tierId: 'tier-2' })).not.toBe(llavePrecio(base));
    expect(llavePrecio({ ...base, accountId: 'acct_2' })).not.toBe(llavePrecio(base));
  });

  it('cabe en el límite de Stripe (255) y no filtra datos en claro', () => {
    const k = llavePrecio(base);
    expect(k).toMatch(/^ekko_price_[0-9a-f]{40}$/);
    expect(k).not.toContain('Esencial');
  });
});

describe('clasificarEvento — referencia del pago único (idempotencia de paquetes)', () => {
  const meta = { usuario_id: 'u1', tier_id: 't1' };

  it('Checkout mode payment y su PaymentIntent dan la MISMA referencia', () => {
    const sesion = clasificarEvento({
      type: 'checkout.session.completed', created: 1,
      data: { object: { payment_status: 'paid', mode: 'payment', customer: 'cus_1', payment_intent: 'pi_1', metadata: meta } }
    } as never);
    const pi = clasificarEvento({
      type: 'payment_intent.succeeded', created: 2,
      data: { object: { id: 'pi_1', customer: 'cus_1', metadata: meta } }
    } as never);
    expect(sesion).toMatchObject({ kind: 'activar', referencia: 'pi_1' });
    expect(pi).toMatchObject({ kind: 'activar', referencia: 'pi_1' });
  });

  it('payment_intent expandido (objeto) también', () => {
    const sesion = clasificarEvento({
      type: 'checkout.session.completed', created: 1,
      data: { object: { payment_status: 'paid', mode: 'payment', customer: 'cus_1', payment_intent: { id: 'pi_7' }, metadata: meta } }
    } as never);
    expect(sesion).toMatchObject({ referencia: 'pi_7' });
  });

  it('Checkout mode subscription → sin referencia', () => {
    const sesion = clasificarEvento({
      type: 'checkout.session.completed', created: 1,
      data: { object: { payment_status: 'paid', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', payment_intent: null, metadata: meta } }
    } as never);
    expect(sesion).toMatchObject({ kind: 'activar', referencia: null });
  });
});

// ── F2 · R1: facturas con la forma basil (API 2025-08-27) ────────────────────
describe('R1 · facturas basil y PaymentIntents propios', () => {
  const basil = {
    id: 'in_b1', amount_paid: 85000, amount_due: 85000, currency: 'mxn', customer: 'cus_7', billing_reason: 'subscription_cycle',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_b1', metadata: { app: 'ekko', usuario_id: 'u1' } } },
    payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_b1' } }] }
  };

  it('helpers: suscripción y PaymentIntent en forma basil y legacy', () => {
    expect(suscripcionDeFactura(basil)).toBe('sub_b1');
    expect(paymentIntentDeFactura(basil)).toBe('pi_b1');
    expect(suscripcionDeFactura({ subscription: 'sub_l' })).toBe('sub_l');
    expect(suscripcionDeFactura({ subscription: { id: 'sub_obj' } })).toBe('sub_obj');
    expect(paymentIntentDeFactura({ payment_intent: 'pi_l' })).toBe('pi_l');
    expect(suscripcionDeFactura({})).toBeNull();
    expect(paymentIntentDeFactura({ payments: { data: [] } })).toBeNull();
  });

  it('invoice.paid basil → monto con suscripción y PaymentIntent resueltos', () => {
    const r = extraerMontoDeEvento(ev('invoice.paid', basil));
    expect(r).toMatchObject({ monto_centavos: 85000, stripe_subscription_id: 'sub_b1', stripe_payment_intent_id: 'pi_b1', stripe_invoice_id: 'in_b1' });
  });

  it('invoice.payment_failed basil → failed con la suscripción resuelta', () => {
    const r = extraerMontoDeEvento(ev('invoice.payment_failed', basil));
    expect(r).toMatchObject({ status: 'failed', stripe_subscription_id: 'sub_b1' });
  });

  it('clasificarEvento: invoice.paid basil de renovación → sync con la suscripción', () => {
    expect(clasificarEvento(ev('invoice.paid', basil))).toMatchObject({ kind: 'sync', subscription_id: 'sub_b1', estado: 'activa' });
  });

  it('clasificarEvento: factura basil de OTRA app → ignore app_ajena', () => {
    const ajena = { ...basil, parent: { subscription_details: { subscription: 'sub_x', metadata: { app: 'hogar' } } } };
    expect(clasificarEvento(ev('invoice.paid', ajena))).toMatchObject({ kind: 'ignore', reason: 'app_ajena' });
  });

  it('PaymentIntent sin metadata de EKKO (el de una factura de suscripción en basil) → no se registra: no duplica ni se atribuye', () => {
    expect(extraerMontoDeEvento(ev('payment_intent.succeeded', { id: 'pi_sub', amount: 85000, currency: 'mxn', customer: 'cus_7' }))).toBeNull();
    expect(
      extraerMontoDeEvento(ev('payment_intent.succeeded', { id: 'pi_h', amount: 1000, currency: 'mxn', metadata: { app: 'hogar' } }))
    ).toBeNull();
  });

  it('PaymentIntent de EKKO (paquete o invitados) → sí se registra', () => {
    const r = extraerMontoDeEvento(
      ev('payment_intent.succeeded', { id: 'pi_e', amount: 25000, currency: 'mxn', customer: 'cus_1', metadata: { app: 'ekko', tier_id: 't1' } })
    );
    expect(r).toMatchObject({ monto_centavos: 25000, stripe_payment_intent_id: 'pi_e' });
  });
});
