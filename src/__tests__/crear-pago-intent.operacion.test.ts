import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crearStripeFalso, type StripeFalso } from './helpers/stripeFalso';

/**
 * PKG-01C · crear-pago-intent con `operation_id` (Stripe FALSO, sin red):
 *   1 operation_id → MÁX 1 objeto; MISMA operación → MISMA key, aunque cambien
 *   precio/comisión entre intentos; respuesta perdida → el reintento recupera el
 *   MISMO objeto; legacy sin idempotencia inventada.
 */

const h = vi.hoisted(() => ({
  stripe: null as unknown as StripeFalso,
  tier: null as Record<string, unknown> | null,
  getOrCreate: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'auth-m1' } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === 'tiers') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: h.tier, error: null })) })) })) })) };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { id: 'm1', tenant_id: 't1', rol: 'miembro', email: 'ana@e.mx', status: 'activo', sancionado_at: null }, error: null }))
          }))
        }))
      };
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/stripe')>()),
  getStripe: () => h.stripe
}));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: vi.fn(async () => ({ accountId: 'acct_1', chargesEnabled: true })),
  getOrCreateSocioCustomer: (...a: unknown[]) => h.getOrCreate(...a)
}));

import { handler } from '../../netlify/functions/crear-pago-intent/index';

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OP2 = '9a8b7c6d-5e4f-4a3b-9c1d-0e1f2a3b4c5d';
const PAQUETE = { id: 'tier-pack', slug: 'pack4', activo: true, en_venta: true, tenant_id: 't1', nombre: 'Pack 4', precio_centavos: 85000, moneda: 'MXN', tipo: 'creditos' };
const MENSUAL = { id: 'tier-mes', slug: 'esencial', activo: true, en_venta: true, tenant_id: 't1', nombre: 'Esencial', precio_centavos: 85000, moneda: 'MXN', tipo: 'tiempo' };

const invocar = async (body: Record<string, unknown>) => {
  const r = (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.stripe = crearStripeFalso();
  h.tier = { ...PAQUETE };
  h.getOrCreate.mockResolvedValue('cus_1');
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  delete process.env.EKKO_FEE_PERCENT;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.EKKO_FEE_PERCENT;
});

describe('crear-pago-intent · paquete con operation_id', () => {
  it('2/11 · reintento HTTP de la misma operación → MISMA key y MISMO PaymentIntent (un solo objeto)', async () => {
    const a = await invocar({ tier: 'pack4', operation_id: OP });
    const b = await invocar({ tier: 'pack4', operation_id: OP });
    expect(a.body).toMatchObject({ estado: 'reutilizable', operationId: OP, clientSecret: 'pi_1_secret_x', account: 'acct_1', modo: 'pago' });
    expect(b.body.clientSecret).toBe(a.body.clientSecret);
    expect(b.body.objetoId).toBe(a.body.objetoId);
    expect(h.stripe.estado.pis).toHaveLength(1);
    expect(h.stripe.paymentIntents.create).toHaveBeenCalledTimes(1); // el 2º lo recupera por búsqueda
    expect(h.stripe.paymentIntents.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `ekko:v1:pi_paquete:acct_1:m1:${OP}`, stripeAccount: 'acct_1', maxNetworkRetries: 0 });
  });

  it('24 · respuesta perdida (Stripe creó, la función no lo supo) → resultado_desconocido; el reintento recupera el MISMO objeto', async () => {
    h.stripe.perderRespuesta();
    const a = await invocar({ tier: 'pack4', operation_id: OP });
    expect(a.body).toEqual({ estado: 'resultado_desconocido', operationId: OP });
    expect(JSON.stringify(a.body)).not.toMatch(/timeout|aborted/i); // sin mensaje crudo
    const b = await invocar({ tier: 'pack4', operation_id: OP });
    expect(b.body).toMatchObject({ estado: 'reutilizable', objetoId: 'pi_1' });
    expect(h.stripe.estado.pis).toHaveLength(1);
  });

  it('7 · cambio de PRECIO entre intentos de la misma operación → NO segundo objeto: se cancela el original y queda reemplazable', async () => {
    await invocar({ tier: 'pack4', operation_id: OP });
    h.tier = { ...PAQUETE, precio_centavos: 99000 };
    const b = await invocar({ tier: 'pack4', operation_id: OP });
    expect(b.body).toMatchObject({ estado: 'reemplazable', objetoId: 'pi_1' });
    expect(b.body.clientSecret).toBeUndefined();
    expect(h.stripe.estado.pis).toHaveLength(1);
    expect(h.stripe.estado.pis[0].status).toBe('canceled');
    expect(h.stripe.paymentIntents.cancel.mock.calls[0][2]).toMatchObject({ idempotencyKey: `ekko:v1:pi_paquete:acct_1:m1:${OP}:invalidar`, stripeAccount: 'acct_1' });
    // Nueva intención legítima → nuevo operation_id → nueva key → objeto al precio vigente.
    const c = await invocar({ tier: 'pack4', operation_id: OP2 });
    expect(c.body).toMatchObject({ estado: 'reutilizable', objetoId: 'pi_2', monto: 99000 });
    expect(h.stripe.paymentIntents.create.mock.calls[1][1].idempotencyKey).toBe(`ekko:v1:pi_paquete:acct_1:m1:${OP2}`);
  });

  it('8 · cambio de COMISIÓN entre intentos → NO segundo objeto', async () => {
    await invocar({ tier: 'pack4', operation_id: OP });
    process.env.EKKO_FEE_PERCENT = '5';
    const b = await invocar({ tier: 'pack4', operation_id: OP });
    expect(b.body.estado).toBe('reemplazable');
    expect(h.stripe.estado.pis).toHaveLength(1);
  });

  it('la key NO cambia con el precio: el create usa la misma key aunque la configuración cambie', async () => {
    h.stripe.perderRespuesta(); // creado a 85000, respuesta perdida
    await invocar({ tier: 'pack4', operation_id: OP });
    h.tier = { ...PAQUETE, precio_centavos: 99000 };
    await invocar({ tier: 'pack4', operation_id: OP });
    const keys = h.stripe.paymentIntents.create.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(h.stripe.estado.pis).toHaveLength(1);
  });

  it('9 · el mismo operation_id para OTRO objetivo → operacion_invalida; nada se crea ni se cancela', async () => {
    await invocar({ tier: 'pack4', operation_id: OP });
    h.tier = { ...PAQUETE, id: 'tier-otro', slug: 'pack8' };
    const b = await invocar({ tier: 'pack8', operation_id: OP });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ estado: 'operacion_invalida' });
    expect(h.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(h.stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('operación ya cobrada → ya_pagado, sin clientSecret y sin crear otra', async () => {
    await invocar({ tier: 'pack4', operation_id: OP });
    h.stripe.estado.pis[0].status = 'succeeded';
    const b = await invocar({ tier: 'pack4', operation_id: OP });
    expect(b.body).toMatchObject({ estado: 'ya_pagado', objetoId: 'pi_1', creadoEn: expect.any(Number) });
    expect(b.body.clientSecret).toBeUndefined();
    expect(h.stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it('16/28 · cuenta conectada en TODAS las llamadas; metadata con operation_id y target, sin PII', async () => {
    await invocar({ tier: 'pack4', operation_id: OP });
    for (const call of [h.stripe.paymentIntents.list.mock.calls[0], h.stripe.paymentIntents.create.mock.calls[0]]) {
      expect(call[1].stripeAccount).toBe('acct_1');
    }
    const meta = h.stripe.estado.pis[0].metadata;
    expect(meta).toEqual({ app: 'ekko', usuario_id: 'm1', tier_id: 'tier-pack', operation_id: OP, ekko_target: 'paquete:tier-pack' });
    expect(JSON.stringify(meta)).not.toMatch(/ana@e\.mx|Ana/);
  });

  it('operation_id no-UUID → 400 sin tocar Stripe', async () => {
    const r = await invocar({ tier: 'pack4', operation_id: 'legacy' });
    expect(r.status).toBe(400);
    expect(h.stripe.paymentIntents.list).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('fallo al preparar el customer → estado clasificado, nunca el mensaje crudo', async () => {
    h.getOrCreate.mockRejectedValue(Object.assign(new Error('No such customer: cus_x (acct_1)'), { type: 'StripeInvalidRequestError', statusCode: 400 }));
    const r = await invocar({ tier: 'pack4', operation_id: OP });
    expect(r.body).toEqual({ estado: 'pago_no_iniciable', operationId: OP });
    expect(JSON.stringify(r.body)).not.toMatch(/No such customer/);
  });

  it('el customer se prepara con el presupuesto interno (opciones de tiempo)', async () => {
    await invocar({ tier: 'pack4', operation_id: OP });
    expect(h.getOrCreate.mock.calls[0][4]).toMatchObject({ presupuesto: expect.any(Object) });
  });
});

describe('crear-pago-intent · mensual (subscription) con operation_id', () => {
  beforeEach(() => {
    h.tier = { ...MENSUAL };
  });

  it('14 · reintento → MISMA suscripción (un solo objeto) y secret de la primera factura', async () => {
    const a = await invocar({ tier: 'esencial', operation_id: OP });
    const b = await invocar({ tier: 'esencial', operation_id: OP });
    expect(a.body).toMatchObject({ estado: 'reutilizable', modo: 'suscripcion', clientSecret: expect.stringMatching(/^in_\d+_secret$/), subscriptionId: 'sub_1' });
    expect(b.body.objetoId).toBe('sub_1');
    expect(h.stripe.estado.subs).toHaveLength(1);
    expect(h.stripe.subscriptions.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `ekko:v1:sub_mensual:acct_1:m1:${OP}`, stripeAccount: 'acct_1' });
  });

  it('drift de precio en suscripción incompleta → NO se cancela ni se crea otra: se reutiliza la original con su importe REAL', async () => {
    await invocar({ tier: 'esencial', operation_id: OP });
    h.tier = { ...MENSUAL, precio_centavos: 99000 };
    const b = await invocar({ tier: 'esencial', operation_id: OP });
    expect(b.body).toMatchObject({ estado: 'reutilizable', objetoId: 'sub_1', monto: 85000 });
    expect(h.stripe.estado.subs).toHaveLength(1);
  });

  it('19/20 · active SIN factura pagada no se afirma pagado → requiere_revision; con evidencia → ya_pagado', async () => {
    await invocar({ tier: 'esencial', operation_id: OP });
    const s = h.stripe.estado.subs[0];
    s.status = 'active';
    s.latest_invoice = { id: 'in_x', status: 'open', amount_paid: 0 };
    expect((await invocar({ tier: 'esencial', operation_id: OP })).body.estado).toBe('requiere_revision');
    s.latest_invoice = { id: 'in_x', status: 'paid', amount_paid: 85000 };
    expect((await invocar({ tier: 'esencial', operation_id: OP })).body.estado).toBe('ya_pagado');
    expect(h.stripe.estado.subs).toHaveLength(1);
  });

  it('incomplete_expired → reemplazable (nueva intención = nuevo operation_id)', async () => {
    await invocar({ tier: 'esencial', operation_id: OP });
    const s = h.stripe.estado.subs[0];
    s.status = 'incomplete_expired';
    s.latest_invoice = { id: 'in_x', status: 'void', amount_paid: 0 };
    expect((await invocar({ tier: 'esencial', operation_id: OP })).body.estado).toBe('reemplazable');
  });
});

describe('crear-pago-intent · 29 · cliente legacy (sin operation_id)', () => {
  it('comportamiento anterior: SIN idempotency key inventada, marca diagnóstica y log sin PII', async () => {
    const info = vi.spyOn(console, 'info');
    const r = await invocar({ tier: 'pack4' });
    expect(r.body).toMatchObject({ clientSecret: 'pi_1_secret_x', account: 'acct_1', modo: 'pago' });
    expect(r.body.estado).toBeUndefined();
    expect(h.stripe.paymentIntents.create.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_1' });
    expect(h.stripe.paymentIntents.list).not.toHaveBeenCalled();
    expect(h.stripe.estado.pis[0].metadata).toMatchObject({ ekko_op: 'legacy' });
    expect(h.stripe.estado.pis[0].metadata.operation_id).toBeUndefined();
    const log = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('pago_op_legacy'));
    expect(JSON.parse(log!)).toMatchObject({ evento: 'pago_op_legacy', funcion: 'crear-pago-intent', kind: 'pi_paquete', usuario_id: 'm1', legacy: true });
    expect(log).not.toMatch(/ana@e\.mx/);
    // Dos llamadas legacy = dos objetos (riesgo residual conocido, igual que antes).
    await invocar({ tier: 'pack4' });
    expect(h.stripe.estado.pis).toHaveLength(2);
  });
});
