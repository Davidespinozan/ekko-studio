import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  leerOperationId,
  llaveOperacion,
  llaveInvalidacion,
  llaveCustomer,
  llaveCuentaConectada,
  crearPresupuesto,
  clasificarErrorSaliente,
  clasificarPaymentIntent,
  clasificarSuscripcion,
  clasificarCheckout,
  ejecutarOperacion,
  evidenciaPagoInicial,
  porOperacion,
  PresupuestoAgotado,
  RechazoNegocio,
  PRESUPUESTO_TOTAL_MS,
  type Evaluacion,
  type OperacionStripe
} from '../../netlify/functions/_lib/operacionPago';
import { clasificarEvento } from '../../netlify/functions/_lib/stripe';

/**
 * PKG-01C — frontera saliente hacia Stripe (helpers puros + orquestación con
 * SDK simulado). Sin Stripe LIVE.
 *   1 operation_id → MÁX 1 objeto lógico de Stripe
 *   MISMA operación lógica → MISMA idempotency key (no cambia por precio,
 *   comisión, configuración, reintento, refresh, pestaña ni paso del tiempo).
 */

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OP2 = '9a8b7c6d-5e4f-4a3b-9c1d-0e1f2a3b4c5d';

describe('identidad de la operación y keys', () => {
  it('1 · misma operación → misma key; la key NO contiene precio/comisión (no hay huella financiera)', () => {
    const k1 = llaveOperacion('pi_paquete', 'acct_1', 'u-1', OP);
    const k2 = llaveOperacion('pi_paquete', 'acct_1', 'u-1', OP);
    expect(k1).toBe(k2);
    expect(k1).toBe(`ekko:v1:pi_paquete:acct_1:u-1:${OP}`);
    expect(k1.length).toBeLessThanOrEqual(255);
  });

  it('5 · otra operación (otra intención) → otra key; kind/cuenta/usuario la separan', () => {
    const base = llaveOperacion('pi_paquete', 'acct_1', 'u-1', OP);
    expect(llaveOperacion('pi_paquete', 'acct_1', 'u-1', OP2)).not.toBe(base);
    expect(llaveOperacion('pi_invitados', 'acct_1', 'u-1', OP)).not.toBe(base);
    expect(llaveOperacion('pi_paquete', 'acct_2', 'u-1', OP)).not.toBe(base);
    expect(llaveOperacion('pi_paquete', 'acct_1', 'u-2', OP)).not.toBe(base);
    expect(llaveInvalidacion('pi_paquete', 'acct_1', 'u-1', OP)).toBe(`${base}:invalidar`);
  });

  it('26/27 · customer por (cuenta, usuario) y cuenta Express estable por tenant', () => {
    expect(llaveCustomer('acct_1', 'u-1')).toBe('ekko:v1:cus:acct_1:u-1');
    expect(llaveCustomer('acct_2', 'u-1')).not.toBe(llaveCustomer('acct_1', 'u-1'));
    expect(llaveCuentaConectada('t-1')).toBe('ekko:v1:acct:t-1');
    expect(llaveCuentaConectada('t-1')).toBe(llaveCuentaConectada('t-1'));
  });

  it('operation_id: ausente = legacy; no-UUID = inválido; UUID = ok (normalizado)', () => {
    expect(leerOperationId(undefined)).toEqual({ tipo: 'ausente' });
    expect(leerOperationId('')).toEqual({ tipo: 'ausente' });
    expect(leerOperationId('legacy')).toEqual({ tipo: 'invalido' });
    expect(leerOperationId('ana@e.mx')).toEqual({ tipo: 'invalido' });
    expect(leerOperationId(12345)).toEqual({ tipo: 'invalido' });
    expect(leerOperationId(OP.toUpperCase())).toEqual({ tipo: 'ok', id: OP });
  });
});

describe('presupuesto interno (8 s, no es el límite de la plataforma)', () => {
  it('timeout por llamada = min(4000, restante − reserva); mutación sin reintentos del SDK', () => {
    let t = 0;
    const p = crearPresupuesto({ ahora: () => t });
    expect(PRESUPUESTO_TOTAL_MS).toBe(8000);
    expect(p.opcionesMutacion()).toEqual({ timeout: 4000, maxNetworkRetries: 0 });
    t = 5000; // quedan 3000, útiles 2000
    expect(p.opcionesMutacion()).toEqual({ timeout: 2000, maxNetworkRetries: 0 });
  });

  it('lecturas: 1 reintento solo si caben dos intentos + backoff; si no, 0', () => {
    let t = 0;
    const p = crearPresupuesto({ ahora: () => t });
    expect(p.opcionesLectura()).toEqual({ timeout: 3000, maxNetworkRetries: 1 });
    t = 2000;
    expect(p.opcionesLectura().maxNetworkRetries).toBe(0);
  });

  it('25 · sin margen seguro no se inicia una mutación', () => {
    let t = 0;
    const p = crearPresupuesto({ ahora: () => t });
    expect(p.puedeMutar()).toBe(true);
    t = 5600; // útiles 1400 < 1500
    expect(p.puedeMutar()).toBe(false);
    t = 8000;
    expect(p.puedeLeer()).toBe(false);
  });
});

describe('clasificación de errores salientes', () => {
  const e = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
  it('409 / idempotency_error → conflicto (se relee la MISMA operación)', () => {
    expect(clasificarErrorSaliente(e('StripeIdempotencyError'), 'mutacion')).toBe('conflicto');
    expect(clasificarErrorSaliente(e('StripeAPIError', { statusCode: 409 }), 'mutacion')).toBe('conflicto');
  });
  it('24 · timeout/conexión en MUTACIÓN → resultado_desconocido (no "falló"); en lectura → reintentable', () => {
    expect(clasificarErrorSaliente(e('StripeConnectionError'), 'mutacion')).toBe('resultado_desconocido');
    expect(clasificarErrorSaliente(e('StripeAPIError', { statusCode: 500 }), 'mutacion')).toBe('resultado_desconocido');
    expect(clasificarErrorSaliente(e('StripeConnectionError'), 'lectura')).toBe('reintentable');
  });
  it('definitivos y configuración', () => {
    expect(clasificarErrorSaliente(e('StripeInvalidRequestError', { statusCode: 400 }), 'mutacion')).toBe('pago_no_iniciable');
    expect(clasificarErrorSaliente(e('StripePermissionError'), 'mutacion')).toBe('cobros_no_disponibles');
    expect(clasificarErrorSaliente(e('StripeRateLimitError'), 'mutacion')).toBe('reintentable');
    expect(clasificarErrorSaliente(new PresupuestoAgotado(), 'mutacion')).toBe('reintentable');
  });
});

const ESP = { target: 'paquete:tier1', amount: 85000, currency: 'mxn', fee: 0, metadata: { tier_id: 'tier1' } };
const pi = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'pi_1', status, amount: 85000, currency: 'mxn', application_fee_amount: null, created: 1, client_secret: 'pi_1_secret', metadata: { ekko_target: 'paquete:tier1', tier_id: 'tier1', operation_id: OP }, ...extra }) as unknown as Stripe.PaymentIntent;

describe('17 · PaymentIntent clasificado por estado observable (ninguno concede entitlement)', () => {
  it.each([
    ['requires_payment_method', 'reutilizable'],
    ['requires_confirmation', 'reutilizable'],
    ['requires_action', 'reutilizable'],
    ['processing', 'en_proceso'],
    ['succeeded', 'ya_pagado'],
    ['canceled', 'reemplazable'],
    ['requires_capture', 'requiere_revision'],
    ['algo_nuevo', 'desconocido']
  ])('%s → %s', (status, veredicto) => {
    expect(clasificarPaymentIntent(pi(status), ESP).veredicto).toBe(veredicto);
  });

  it('drift de precio o comisión se detecta contra el OBJETO (no cambia la key)', () => {
    expect(clasificarPaymentIntent(pi('requires_payment_method'), { ...ESP, amount: 99000 })).toMatchObject({ drift: true, invalidable: true });
    expect(clasificarPaymentIntent(pi('requires_payment_method'), { ...ESP, fee: 850 }).drift).toBe(true);
    expect(clasificarPaymentIntent(pi('requires_payment_method'), ESP).drift).toBe(false);
  });

  it('9 · target distinto → operacion_invalida', () => {
    expect(clasificarPaymentIntent(pi('requires_payment_method'), { ...ESP, target: 'paquete:otro' }).veredicto).toBe('operacion_invalida');
  });
});

const ESP_SUB = { target: 'mensual:tier1', amount: 85000, currency: 'mxn', fee: 0, metadata: { tier_id: 'tier1' } };
const sub = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'sub_1', status, created: 1, metadata: { ekko_target: 'mensual:tier1', tier_id: 'tier1', operation_id: OP }, items: { data: [{ price: { unit_amount: 85000, currency: 'mxn' } }] }, ...extra }) as unknown as Stripe.Subscription;

describe('18/19/20 · Subscription clasificada con evidencia financiera, no solo por status', () => {
  it('incomplete → reutilizable (sin pago); con primera factura pagada → en_proceso (activa el webhook)', () => {
    expect(clasificarSuscripcion(sub('incomplete'), ESP_SUB, 'no_pagada').veredicto).toBe('reutilizable');
    expect(clasificarSuscripcion(sub('incomplete'), ESP_SUB, 'pagada').veredicto).toBe('en_proceso');
  });
  it('active → ya_pagado SOLO con evidencia; sin ella → requiere_revision', () => {
    expect(clasificarSuscripcion(sub('active'), ESP_SUB, 'pagada').veredicto).toBe('ya_pagado');
    expect(clasificarSuscripcion(sub('active'), ESP_SUB, 'no_pagada').veredicto).toBe('requiere_revision');
  });
  it('19 · past_due NO significa pagado automáticamente', () => {
    expect(clasificarSuscripcion(sub('past_due'), ESP_SUB, 'no_pagada').veredicto).toBe('requiere_revision');
    expect(clasificarSuscripcion(sub('past_due'), ESP_SUB, 'desconocida').veredicto).toBe('desconocido');
    expect(clasificarSuscripcion(sub('past_due'), ESP_SUB, 'pagada').veredicto).toBe('ya_pagado');
  });
  it('20 · trialing NO significa pagado salvo prueba explícita (EKKO no usa trials en este flujo)', () => {
    expect(clasificarSuscripcion(sub('trialing'), ESP_SUB, 'no_pagada').veredicto).toBe('requiere_revision');
    expect(clasificarSuscripcion(sub('trialing'), ESP_SUB, 'pagada').veredicto).toBe('ya_pagado');
  });
  it('canceled: pagada → ya_pagado; factura anulada → reemplazable; factura aún cobrable → requiere_revision', () => {
    expect(clasificarSuscripcion(sub('canceled'), ESP_SUB, 'pagada').veredicto).toBe('ya_pagado');
    expect(clasificarSuscripcion(sub('canceled'), ESP_SUB, 'anulada').veredicto).toBe('reemplazable');
    expect(clasificarSuscripcion(sub('canceled'), ESP_SUB, 'no_pagada').veredicto).toBe('requiere_revision');
  });
  it('incomplete_expired → reemplazable; desconocido → desconocido; nunca invalidable (no se cancela por drift)', () => {
    expect(clasificarSuscripcion(sub('incomplete_expired'), ESP_SUB, 'anulada').veredicto).toBe('reemplazable');
    expect(clasificarSuscripcion(sub('raro'), ESP_SUB, 'no_pagada').veredicto).toBe('desconocido');
    const drift = clasificarSuscripcion(sub('incomplete'), { ...ESP_SUB, amount: 99000 }, 'no_pagada');
    expect(drift).toMatchObject({ veredicto: 'reutilizable', drift: true, invalidable: false });
  });
});

const ESP_CS = { target: 'checkout_paquete:tier1', amount: 85000, currency: 'mxn', fee: null, mode: 'payment' as const, embedded: true, metadata: { tier_id: 'tier1' } };
const cs = (status: string, payment_status: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'cs_1', status, payment_status, amount_total: 85000, currency: 'mxn', mode: 'payment', ui_mode: 'embedded', client_secret: 'cs_secret', url: null, created: 1, metadata: { ekko_target: 'checkout_paquete:tier1', tier_id: 'tier1', operation_id: OP }, ...extra }) as unknown as Stripe.Checkout.Session;

describe('21 · Checkout Session clasificada por estado', () => {
  it.each([
    ['open', 'unpaid', 'reutilizable'],
    ['complete', 'paid', 'ya_pagado'],
    ['complete', 'unpaid', 'en_proceso'],
    ['complete', 'no_payment_required', 'requiere_revision'],
    ['expired', 'unpaid', 'reemplazable'],
    ['raro', 'unpaid', 'desconocido']
  ])('%s + %s → %s', (status, ps, veredicto) => {
    expect(clasificarCheckout(cs(status, ps), ESP_CS).veredicto).toBe(veredicto);
  });
  it('abierta sin client_secret recuperable → drift (se expira, no se reutiliza a ciegas)', () => {
    expect(clasificarCheckout(cs('open', 'unpaid', { client_secret: null }), ESP_CS)).toMatchObject({ veredicto: 'reutilizable', drift: true, invalidable: true });
  });
});

// ── Orquestación ─────────────────────────────────────────────────────────────

function op(o: Partial<OperacionStripe<Stripe.PaymentIntent>> & { evaluar?: (x: Stripe.PaymentIntent) => Promise<Evaluacion> }) {
  return {
    buscar: vi.fn(async () => null),
    crear: vi.fn(async () => pi('requires_payment_method')),
    evaluar: vi.fn(async (x: Stripe.PaymentIntent) => clasificarPaymentIntent(x, ESP)),
    ...o
  } as OperacionStripe<Stripe.PaymentIntent> & { buscar: ReturnType<typeof vi.fn>; crear: ReturnType<typeof vi.fn> };
}

describe('ejecutarOperacion · recuperar la MISMA operación o crearla con la key estable', () => {
  it('11 · la operación ya existe → se clasifica y NO se crea otra', async () => {
    const o = op({ buscar: vi.fn(async () => pi('requires_payment_method')) });
    const r = await ejecutarOperacion(o, crearPresupuesto());
    expect(r).toMatchObject({ tipo: 'objeto', veredicto: 'reutilizable' });
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('16 · no depende de Idempotent-Replayed: un replay con estado viejo se reconoce al buscar por estado actual', async () => {
    // El objeto "original" ya está pagado; la búsqueda lo ve así (sin cabeceras).
    const o = op({ buscar: vi.fn(async () => pi('succeeded')) });
    const r = await ejecutarOperacion(o, crearPresupuesto());
    expect(r).toMatchObject({ tipo: 'objeto', veredicto: 'ya_pagado' });
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('7 · drift de precio en PI cancelable → se CANCELA y solo con estado canceled es reemplazable; NO hay segundo objeto', async () => {
    const invalidar = vi.fn(async () => pi('canceled', { amount: 85000 }));
    const o = op({
      buscar: vi.fn(async () => pi('requires_payment_method')),
      evaluar: vi.fn(async (x: Stripe.PaymentIntent) => clasificarPaymentIntent(x, { ...ESP, amount: 99000 })),
      invalidar
    });
    const r = await ejecutarOperacion(o, crearPresupuesto());
    expect(r).toMatchObject({ tipo: 'objeto', veredicto: 'reemplazable' });
    expect(invalidar).toHaveBeenCalledTimes(1);
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('8 · drift de comisión → mismo tratamiento, sin segundo objeto', async () => {
    const invalidar = vi.fn(async () => pi('canceled'));
    const o = op({
      buscar: vi.fn(async () => pi('requires_payment_method')),
      evaluar: vi.fn(async (x: Stripe.PaymentIntent) => clasificarPaymentIntent(x, { ...ESP, fee: 1234 })),
      invalidar
    });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toMatchObject({ veredicto: 'reemplazable' });
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('cancel falla → NO se asume: se relee y reclasifica (p. ej. ya se cobró → ya_pagado)', async () => {
    const o = op({
      buscar: vi.fn(async () => pi('requires_payment_method')),
      evaluar: vi.fn(async (x: Stripe.PaymentIntent) => clasificarPaymentIntent(x, { ...ESP, amount: 99000 })),
      invalidar: vi.fn(async () => { throw Object.assign(new Error('no cancelable'), { type: 'StripeInvalidRequestError' }); }),
      releer: vi.fn(async () => pi('succeeded'))
    });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toMatchObject({ tipo: 'objeto', veredicto: 'ya_pagado' });
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('cancel falla y sigue cobrable con drift → reintentable (ni reutilizar el importe viejo ni crear otro)', async () => {
    const o = op({
      buscar: vi.fn(async () => pi('requires_payment_method')),
      evaluar: vi.fn(async (x: Stripe.PaymentIntent) => clasificarPaymentIntent(x, { ...ESP, amount: 99000 })),
      invalidar: vi.fn(async () => { throw new Error('red'); }),
      releer: vi.fn(async () => pi('requires_payment_method'))
    });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toEqual({ tipo: 'transporte', veredicto: 'reintentable' });
  });

  it('9 · target distinto para el mismo operation_id → operacion_invalida, sin crear ni cancelar', async () => {
    const invalidar = vi.fn();
    const o = op({
      buscar: vi.fn(async () => pi('requires_payment_method', { metadata: { ekko_target: 'invitados:res_9', operation_id: OP } })),
      invalidar
    });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toMatchObject({ veredicto: 'operacion_invalida' });
    expect(o.crear).not.toHaveBeenCalled();
    expect(invalidar).not.toHaveBeenCalled();
  });

  it('22 · create choca (409/idempotency_error) → se busca de nuevo ESA operación y se clasifica', async () => {
    const buscar = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(pi('requires_payment_method'));
    const o = op({ buscar, crear: vi.fn(async () => { throw Object.assign(new Error('in progress'), { type: 'StripeIdempotencyError', statusCode: 409 }); }) });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toMatchObject({ tipo: 'objeto', veredicto: 'reutilizable' });
    expect(buscar).toHaveBeenCalledTimes(2);
    expect(o.crear).toHaveBeenCalledTimes(1); // nunca con otra key
  });

  it('22b · conflicto y la relectura no la encuentra → resultado_desconocido (conservador)', async () => {
    const o = op({ crear: vi.fn(async () => { throw Object.assign(new Error('x'), { type: 'StripeIdempotencyError' }); }) });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toEqual({ tipo: 'transporte', veredicto: 'resultado_desconocido' });
    expect(o.crear).toHaveBeenCalledTimes(1);
  });

  it('23 · la búsqueda falla → NO se crea (no se sabe si el objeto existe); ninguna segunda key', async () => {
    const o = op({ buscar: vi.fn(async () => { throw Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }); }) });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toEqual({ tipo: 'transporte', veredicto: 'reintentable' });
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('24 · timeout ambiguo al crear → resultado_desconocido (la operación se conserva para reintentar)', async () => {
    const o = op({ crear: vi.fn(async () => { throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }); }) });
    expect(await ejecutarOperacion(o, crearPresupuesto())).toEqual({ tipo: 'transporte', veredicto: 'resultado_desconocido' });
  });

  it('25 · sin presupuesto para mutar → no se envía el create (reintentable)', async () => {
    let t = 0;
    const p = crearPresupuesto({ ahora: () => t });
    const o = op({ buscar: vi.fn(async () => { t = 5700; return null; }) });
    expect(await ejecutarOperacion(o, p)).toEqual({ tipo: 'transporte', veredicto: 'reintentable' });
    expect(o.crear).not.toHaveBeenCalled();
  });

  it('una regla de negocio al crear (RechazoNegocio) se propaga (400), sin llamar a Stripe', async () => {
    const o = op({ crear: vi.fn(async () => { throw new RechazoNegocio('tope'); }) });
    await expect(ejecutarOperacion(o, crearPresupuesto())).rejects.toBeInstanceOf(RechazoNegocio);
  });

  it('porOperacion elige SOLO el objeto de esa operación (no adopta otra del mismo target)', () => {
    const otra = pi('requires_payment_method', { id: 'pi_otra', metadata: { ekko_target: 'paquete:tier1', operation_id: OP2 } });
    expect(porOperacion([otra], OP)).toBeNull();
    expect(porOperacion([otra, pi('requires_payment_method')], OP)?.id).toBe('pi_1');
  });
});

describe('evidencia de pago inicial de una suscripción (solo lectura)', () => {
  const stripe = (lista: unknown[] | Error) =>
    ({ invoices: { list: vi.fn(async () => { if (lista instanceof Error) throw lista; return { data: lista }; }) } }) as unknown as Stripe;
  it('incomplete: la última factura es la primera → no hace falta leer', async () => {
    const s = stripe([]);
    expect(await evidenciaPagoInicial(s, { id: 'sub_1', status: 'incomplete', latest_invoice: { status: 'open', amount_paid: 0 } } as never, { stripeAccount: 'acct_1' }, crearPresupuesto())).toBe('no_pagada');
    expect((s.invoices.list as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
  it('past_due con factura de alta pagada (>0) → pagada; $0 no cuenta como pago', async () => {
    expect(await evidenciaPagoInicial(stripe([{ status: 'paid', amount_paid: 85000 }]), { id: 'sub_1', status: 'past_due', latest_invoice: { status: 'open', amount_paid: 0 } } as never, { stripeAccount: 'acct_1' }, crearPresupuesto())).toBe('pagada');
    expect(await evidenciaPagoInicial(stripe([{ status: 'paid', amount_paid: 0 }]), { id: 'sub_1', status: 'trialing', latest_invoice: { status: 'paid', amount_paid: 0 } } as never, { stripeAccount: 'acct_1' }, crearPresupuesto())).toBe('no_pagada');
  });
  it('lectura fallida → desconocida (nunca se asume pagado)', async () => {
    expect(await evidenciaPagoInicial(stripe(new Error('x')), { id: 'sub_1', status: 'active', latest_invoice: 'in_1' } as never, { stripeAccount: 'acct_1' }, crearPresupuesto())).toBe('desconocida');
  });
});

// ── 30/31 · 01A/01B: la metadata nueva NO cambia la clasificación del webhook ──

const ev = (type: string, object: Record<string, unknown>) => ({ id: 'evt_1', type, created: 1_700_000_000, data: { object } }) as unknown as Stripe.Event;
const EXTRA = { operation_id: OP, ekko_target: 'paquete:t1' };

describe('compatibilidad con el webhook (01A/01B intactos)', () => {
  it('30 · payment_intent.succeeded de paquete: misma acción con y sin operation_id/ekko_target', () => {
    const base = { id: 'pi_1', customer: 'cus_1', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } };
    const sin = clasificarEvento(ev('payment_intent.succeeded', base));
    const con = clasificarEvento(ev('payment_intent.succeeded', { ...base, metadata: { ...base.metadata, ...EXTRA } }));
    expect(con).toEqual(sin);
    expect(con.kind).toBe('activar');
  });

  it('30 · invitados_extra: misma acción con operation_id', () => {
    const base = { id: 'pi_2', customer: 'cus_1', metadata: { app: 'ekko', tipo: 'invitados_extra', reserva_id: 'r1', cantidad: '2', usuario_id: 'u1' } };
    expect(clasificarEvento(ev('payment_intent.succeeded', { ...base, metadata: { ...base.metadata, ...EXTRA } }))).toEqual(clasificarEvento(ev('payment_intent.succeeded', base)));
  });

  it('31 · 01B: checkout.session.completed sigue exigiendo paid, con o sin la metadata nueva', () => {
    const base = { mode: 'payment', subscription: null, customer: 'cus_1', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1', ...EXTRA } };
    expect(clasificarEvento(ev('checkout.session.completed', { ...base, payment_status: 'paid' })).kind).toBe('activar');
    expect(clasificarEvento(ev('checkout.session.completed', { ...base, payment_status: 'unpaid' })).kind).toBe('ignore');
  });
});
