import { describe, it, expect } from 'vitest';
import {
  clasificarEvento,
  clasificarError,
  accionIdempotente,
  resumenEvento,
  redactarPayload,
  DivergenciaWebhook,
  ErrorRpcWebhook
} from '../../netlify/functions/_lib/stripe';

/**
 * PKG-01A — Helpers PUROS del estado durable del webhook:
 * clasificación de errores (permanente vs transitorio), regla de idempotencia
 * por acción, resumen sin PII y redacción del payload.
 */

type Ev = Parameters<typeof clasificarEvento>[0];
const ev = (type: string, object: unknown, extra: Record<string, unknown> = {}): Ev =>
  ({ id: 'evt_x', type, created: 1_780_000_000, livemode: true, api_version: '2026-04-22.dahlia', data: { object }, ...extra }) as unknown as Ev;

describe('clasificarEvento: dinero de EKKO con datos inutilizables → revision (no ignore)', () => {
  it('checkout.session.completed sin usuario/plan → revision faltan_datos_en_session', () => {
    const r = clasificarEvento(ev('checkout.session.completed', { mode: 'payment', customer: 'cus_1', metadata: {} }));
    expect(r).toEqual({ kind: 'revision', motivo: 'faltan_datos_en_session' });
  });

  it('checkout de otra app → sigue siendo ignore app_ajena', () => {
    const r = clasificarEvento(ev('checkout.session.completed', { mode: 'payment', customer: 'cus_1', metadata: { app: 'sala' } }));
    expect(r).toEqual({ kind: 'ignore', reason: 'app_ajena' });
  });

  it('payment_intent.succeeded con app=ekko pero sin usuario/plan → revision', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', { id: 'pi_1', customer: 'cus_1', amount: 100, metadata: { app: 'ekko' } }));
    expect(r).toEqual({ kind: 'revision', motivo: 'payment_intent_ekko_sin_datos' });
  });

  it('payment_intent.succeeded sin metadata (PI de factura de suscripción) → ignore, como antes', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', { id: 'pi_1', customer: 'cus_1', amount: 100, metadata: {} }));
    expect(r).toEqual({ kind: 'ignore', reason: 'payment_intent_sin_metadata' });
  });

  it('invitados extra pagados sin reserva/cantidad → revision', () => {
    const r = clasificarEvento(ev('payment_intent.succeeded', { id: 'pi_1', amount: 100, metadata: { app: 'ekko', tipo: 'invitados_extra', reserva_id: 'r1', cantidad: '0' } }));
    expect(r).toEqual({ kind: 'revision', motivo: 'invitados_extra_sin_datos' });
  });

  it('tipo desconocido firmado → ignore evento_no_manejado:<type>', () => {
    expect(clasificarEvento(ev('price.created', { id: 'price_1' }))).toEqual({ kind: 'ignore', reason: 'evento_no_manejado:price.created' });
  });
});

describe('clasificarError', () => {
  it('divergencias y excepciones de negocio de los RPC (EKKO_*, P0001) → permanente', () => {
    expect(clasificarError(new DivergenciaWebhook('membresia_no_encontrada'))).toBe('permanente');
    expect(clasificarError(new ErrorRpcWebhook('activar_membresia', { message: 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo', code: 'P0001' }))).toBe('permanente');
    expect(clasificarError(new ErrorRpcWebhook('activar_membresia', { message: 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado', code: null }))).toBe('permanente');
  });

  it('integridad/datos (23xxx, 22xxx) y peticiones inválidas a Stripe → permanente', () => {
    expect(clasificarError(new ErrorRpcWebhook('x', { message: 'fk', code: '23503' }))).toBe('permanente');
    expect(clasificarError(new ErrorRpcWebhook('x', { message: 'bad json', code: '22P02' }))).toBe('permanente');
    expect(clasificarError({ type: 'StripeInvalidRequestError', message: 'No such subscription' })).toBe('permanente');
  });

  it('red, 5xx de Stripe, rate limit, timeouts, PostgREST y errores desconocidos → transitorio (nunca catch-all a revisión)', () => {
    expect(clasificarError({ type: 'StripeConnectionError', message: 'ECONNRESET' })).toBe('transitorio');
    expect(clasificarError({ type: 'StripeAPIError', message: '502' })).toBe('transitorio');
    expect(clasificarError({ type: 'StripeRateLimitError', message: '429' })).toBe('transitorio');
    expect(clasificarError(new ErrorRpcWebhook('x', { message: 'canceling statement due to statement timeout', code: '57014' }))).toBe('transitorio');
    expect(clasificarError(new ErrorRpcWebhook('x', { message: 'fetch failed', code: 'PGRST301' }))).toBe('transitorio');
    expect(clasificarError(new Error('TypeError: fetch failed'))).toBe('transitorio');
    expect(clasificarError('cadena')).toBe('transitorio');
    expect(clasificarError(null)).toBe('transitorio');
    // Ante duda (auth/config de Stripe) → transitorio; los intentos agotados lo llevan a revisión.
    expect(clasificarError({ type: 'StripeAuthenticationError', message: 'key' })).toBe('transitorio');
  });
});

describe('accionIdempotente', () => {
  it('solo invitados-extra NO es re-ejecutable tras un crash a medias', () => {
    expect(accionIdempotente('invitados-extra')).toBe(false);
    for (const k of ['activar', 'activar-sub', 'sync', 'reembolso', 'cuenta-conectada', 'ignore', 'revision'] as const) {
      expect(accionIdempotente(k), k).toBe(true);
    }
  });
});

describe('resumenEvento: ids y montos, nunca PII', () => {
  it('factura dahlia: suscripción y metadata desde parent.subscription_details', () => {
    const r = resumenEvento(ev('invoice.paid', {
      object: 'invoice', id: 'in_1', customer: 'cus_1', amount_paid: 85000, currency: 'mxn', status: 'paid', billing_reason: 'subscription_cycle',
      customer_email: 'ana@e.mx', customer_name: 'Ana', customer_address: { city: 'Culiacán' },
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } } }
    }));
    expect(r).toEqual({
      objeto: 'invoice', id: 'in_1', subscription: 'sub_1', customer: 'cus_1', monto: 85000, currency: 'mxn', status: 'paid',
      billing_reason: 'subscription_cycle', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' }
    });
    expect(JSON.stringify(r)).not.toMatch(/ana@e\.mx|Ana|Culiac/);
  });

  it('PaymentIntent de paquete: id, customer, monto y metadata de EKKO; charge desde latest_charge', () => {
    const r = resumenEvento(ev('payment_intent.succeeded', {
      object: 'payment_intent', id: 'pi_1', customer: { id: 'cus_2' }, amount: 25000, currency: 'mxn', status: 'succeeded', latest_charge: 'ch_1',
      receipt_email: 'x@y.z', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1', nota_privada: 'no va' }
    }));
    expect(r).toEqual({ objeto: 'payment_intent', id: 'pi_1', customer: 'cus_2', charge: 'ch_1', monto: 25000, currency: 'mxn', status: 'succeeded', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } });
  });

  it('checkout session: mode y payment_intent; evento sin objeto no rompe', () => {
    const r = resumenEvento(ev('checkout.session.completed', { object: 'checkout.session', id: 'cs_1', mode: 'payment', payment_intent: 'pi_1', amount_total: 1000, customer_details: { email: 'a@b.c' } }));
    expect(r).toMatchObject({ objeto: 'checkout.session', id: 'cs_1', mode: 'payment', payment_intent: 'pi_1', monto: 1000 });
    expect(resumenEvento({ id: 'evt', type: 'x', data: {} } as unknown as Ev)).toEqual({ metadata: {} });
  });
});

describe('redactarPayload', () => {
  it('redacta correo/nombre/dirección/teléfono/billing a cualquier profundidad y conserva ids y montos', () => {
    const evento = ev('invoice.paid', {
      id: 'in_1', customer: 'cus_1', amount_paid: 85000, customer_email: 'ana@e.mx', customer_name: 'Ana',
      customer_address: { line1: 'Calle 1' }, customer_phone: '+52', customer_tax_ids: [{ value: 'RFC' }], receipt_email: null,
      lines: { data: [{ id: 'il_1', amount: 85000, metadata: { name: 'Plan' } }] },
      charge: { id: 'ch_1', billing_details: { email: 'ana@e.mx', name: 'Ana' }, shipping: { address: {} } }
    }, { account: 'acct_1' });
    // eslint no registra no-explicit-any en este repo; `any` solo para inspeccionar la copia redactada.
    const r = redactarPayload(evento) as unknown as { account: string; data: { object: Record<string, any> } };
    const o = r.data.object;
    expect(r.account).toBe('acct_1');
    expect(o.id).toBe('in_1');
    expect(o.amount_paid).toBe(85000);
    expect(o.customer_email).toBe('[redactado]');
    expect(o.customer_name).toBe('[redactado]');
    expect(o.customer_address).toBe('[redactado]');
    expect(o.customer_phone).toBe('[redactado]');
    expect(o.customer_tax_ids).toBe('[redactado]');
    expect(o.receipt_email).toBeNull(); // null se conserva como null
    expect(o.lines.data[0].id).toBe('il_1');
    expect(o.lines.data[0].metadata.name).toBe('[redactado]');
    expect(o.charge.billing_details).toBe('[redactado]');
    expect(o.charge.shipping).toBe('[redactado]');
    expect(JSON.stringify(r)).not.toMatch(/ana@e\.mx|Calle 1|\+52|RFC/);
  });

  it('no muta el evento original', () => {
    const evento = ev('x', { customer_email: 'a@b.c', id: 'in_1' });
    redactarPayload(evento);
    expect((evento.data.object as { customer_email: string }).customer_email).toBe('a@b.c');
  });
});
