import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearStripeFalso, type StripeFalso } from './helpers/stripeFalso';

/**
 * PKG-01E · mostrador-crear-pago (Stripe FALSO, sin red): el STAFF prepara el
 * cobro de un plan para un MIEMBRO objetivo. Identidad = (cuenta, miembro,
 * operation_id) → key `ekko:v1:<kind>:<acct>:<miembro>:<op>` (01C). El customer
 * es del miembro. El importe sale del catálogo. No activa nada: eso es del
 * webhook (01A → R1).
 */

const h = vi.hoisted(() => ({
  stripe: null as unknown as StripeFalso,
  caller: null as Record<string, unknown> | null,
  target: null as Record<string, unknown> | null,
  tier: null as Record<string, unknown> | null,
  subViva: null as Record<string, unknown> | null,
  getOrCreate: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'auth-staff' } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === 'tiers') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: h.tier, error: null })) })) })) })) };
      }
      if (table === 'membresias') {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'not', 'limit']) c[m] = () => c;
        c.maybeSingle = async () => ({ data: h.subViva, error: null });
        return c;
      }
      // usuarios: por auth_id = caller (staff); por id = target (miembro).
      return {
        select: vi.fn(() => ({
          eq: vi.fn((col: string) => ({ maybeSingle: vi.fn(async () => ({ data: col === 'auth_id' ? h.caller : h.target, error: null })) }))
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

import { handler } from '../../netlify/functions/mostrador-crear-pago/index';

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const STAFF = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
const MIEMBRO = { id: 'm1', tenant_id: 't1', rol: 'miembro', status: 'activo', email: 'ana@e.mx', sancionado_at: null };
const PAQUETE = { id: 'tier-pack', slug: 'creador', activo: true, en_venta: true, tenant_id: 't1', nombre: 'Creador', precio_centavos: 115000, moneda: 'MXN', tipo: 'hibrido' };
const MENSUAL = { id: 'tier-mes', slug: 'esencial', activo: true, en_venta: true, tenant_id: 't1', nombre: 'Esencial', precio_centavos: 85000, moneda: 'MXN', tipo: 'tiempo' };

const invocar = async (body: Record<string, unknown>) => {
  const r = (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const BODY = { usuario_id: 'm1', tier: 'creador', operation_id: OP };

beforeEach(() => {
  vi.clearAllMocks();
  h.stripe = crearStripeFalso();
  h.caller = { ...STAFF };
  h.target = { ...MIEMBRO };
  h.tier = { ...PAQUETE };
  h.subViva = null;
  h.getOrCreate.mockImplementation(async (_s: unknown, _a: unknown, socio: { id: string }) => `cus_${socio.id}`);
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  delete process.env.EKKO_FEE_PERCENT;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('autorización (cero objetos de Stripe)', () => {
  it('no staff → 403', async () => {
    h.caller = { ...STAFF, rol: 'miembro' };
    expect((await invocar(BODY)).status).toBe(403);
    expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
  it('staff inactivo → 403', async () => {
    h.caller = { ...STAFF, status: 'suspendido' };
    expect((await invocar(BODY)).status).toBe(403);
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });
  it('cross-tenant → 403', async () => {
    h.target = { ...MIEMBRO, tenant_id: 'otro' };
    expect((await invocar(BODY)).status).toBe(403);
    expect(h.stripe.paymentIntents.list).not.toHaveBeenCalled();
  });
  it('recepción sobre una cuenta del equipo → 403; miembro sancionado → 403', async () => {
    h.target = { ...MIEMBRO, rol: 'recepcionista' };
    expect((await invocar(BODY)).status).toBe(403);
    h.target = { ...MIEMBRO, sancionado_at: '2026-09-01T00:00:00Z' };
    expect((await invocar(BODY)).status).toBe(403);
    expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
  it('sin operation_id o no UUID → 400 (sin camino legacy); plan retirado de la venta → 400', async () => {
    expect((await invocar({ usuario_id: 'm1', tier: 'creador' })).status).toBe(400);
    expect((await invocar({ ...BODY, operation_id: 'x' })).status).toBe(400);
    h.tier = { ...PAQUETE, en_venta: false };
    expect((await invocar(BODY)).status).toBe(400);
    expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe('autoridad del importe y del customer', () => {
  it('el cliente no elige el monto: el PaymentIntent lleva el precio del tier aunque el body traiga otro', async () => {
    const r = await invocar({ ...BODY, monto: 1, amount: 1, precio_centavos: 1 });
    expect(r.body).toMatchObject({ estado: 'reutilizable', monto: 115000, moneda: 'mxn', modo: 'pago', miembro: { id: 'm1' } });
    expect(h.stripe.estado.pis[0].amount).toBe(115000);
  });
  it('el customer de Stripe es del MIEMBRO objetivo, nunca del staff', async () => {
    await invocar(BODY);
    expect(h.getOrCreate.mock.calls[0][2]).toMatchObject({ id: 'm1', tenant_id: 't1' });
    expect(h.stripe.estado.pis[0].customer).toBe('cus_m1');
    // El staff aparece solo como atribución en metadata; nunca como customer ni como usuario_id del pago.
    expect(h.stripe.estado.pis[0].customer).not.toBe('cus_u-recep');
    expect(h.stripe.estado.pis[0].metadata.usuario_id).toBe('m1');
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
  });
});

describe('identidad de la operación = (cuenta, miembro, operation_id)', () => {
  it('mismo miembro + mismo operation_id → MISMO objeto; key con el id del miembro', async () => {
    const a = await invocar(BODY);
    const b = await invocar(BODY);
    expect(b.body.objetoId).toBe(a.body.objetoId);
    expect(h.stripe.estado.pis).toHaveLength(1);
    expect(h.stripe.paymentIntents.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `ekko:v1:pi_paquete:acct_1:m1:${OP}`, stripeAccount: 'acct_1', maxNetworkRetries: 0 });
  });

  it('el mismo UUID para OTRO miembro es otra identidad: otra key, otro customer, nunca adopta el objeto del primero', async () => {
    const a = await invocar(BODY);
    h.target = { ...MIEMBRO, id: 'm2', email: 'b@e.mx' };
    const b = await invocar({ ...BODY, usuario_id: 'm2' });
    expect(b.body.objetoId).not.toBe(a.body.objetoId);
    const keys = h.stripe.paymentIntents.create.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys).toEqual([`ekko:v1:pi_paquete:acct_1:m1:${OP}`, `ekko:v1:pi_paquete:acct_1:m2:${OP}`]);
    expect(h.stripe.estado.pis.map((p) => p.customer)).toEqual(['cus_m1', 'cus_m2']);
    // La búsqueda se hizo dentro del customer de cada miembro, no atravesando customers.
    expect(h.stripe.paymentIntents.list.mock.calls.map((c) => c[0].customer)).toEqual(['cus_m1', 'cus_m2']);
  });

  it('respuesta perdida tras crear → resultado_desconocido; el reintento recupera el MISMO objeto', async () => {
    h.stripe.perderRespuesta();
    expect((await invocar(BODY)).body.estado).toBe('resultado_desconocido');
    expect((await invocar(BODY)).body).toMatchObject({ estado: 'reutilizable', objetoId: 'pi_1' });
    expect(h.stripe.estado.pis).toHaveLength(1);
  });
});

describe('guard de suscripción Stripe viva (D-01E-4)', () => {
  it('rechaza 409 suscripcion_stripe ANTES de crear cualquier objeto financiero, también para paquetes', async () => {
    h.subViva = { stripe_subscription_id: 'sub_viva' };
    const r = await invocar(BODY);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('suscripcion_stripe');
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.list).not.toHaveBeenCalled();
    expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe('paquete y mensual', () => {
  it('paquete → PaymentIntent con metadata de mostrador y sin PII', async () => {
    await invocar(BODY);
    const meta = h.stripe.estado.pis[0].metadata;
    expect(meta).toEqual({
      app: 'ekko', usuario_id: 'm1', tier_id: 'tier-pack', operation_id: OP, ekko_target: 'paquete:tier-pack',
      origen: 'mostrador', actor_usuario_id: 'u-recep', actor_rol: 'recepcionista'
    });
    expect(JSON.stringify(meta)).not.toMatch(/ana@e\.mx|Ana/);
  });

  it('mensual → suscripción default_incomplete del miembro con la key sub_mensual y el secret de la primera factura', async () => {
    h.tier = { ...MENSUAL };
    const r = await invocar({ ...BODY, tier: 'esencial' });
    expect(r.body).toMatchObject({ estado: 'reutilizable', modo: 'suscripcion', subscriptionId: 'sub_1', clientSecret: expect.stringMatching(/^in_\d+_secret$/), monto: 85000 });
    expect(h.stripe.subscriptions.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `ekko:v1:sub_mensual:acct_1:m1:${OP}`, stripeAccount: 'acct_1' });
    expect(h.stripe.estado.subs[0].customer).toBe('cus_m1');
    expect(h.stripe.estado.subs[0].metadata).toMatchObject({ origen: 'mostrador', actor_usuario_id: 'u-recep', usuario_id: 'm1' });
  });

  it('mensual activa SIN evidencia de factura pagada no se afirma pagada (requiere_revision); con evidencia, ya_pagado', async () => {
    h.tier = { ...MENSUAL };
    await invocar({ ...BODY, tier: 'esencial' });
    const s = h.stripe.estado.subs[0];
    s.status = 'active';
    s.latest_invoice = { id: 'in_x', status: 'open', amount_paid: 0 };
    expect((await invocar({ ...BODY, tier: 'esencial' })).body.estado).toBe('requiere_revision');
    s.latest_invoice = { id: 'in_x', status: 'paid', amount_paid: 85000 };
    expect((await invocar({ ...BODY, tier: 'esencial' })).body.estado).toBe('ya_pagado');
    expect(h.stripe.estado.subs).toHaveLength(1);
  });

  it('la función nunca llama a activar_membresia ni a registrar_venta_mostrador ni escribe ventas_mostrador', async () => {
    const r = await invocar(BODY);
    expect(r.status).toBe(200);
    // El mock de supabase no expone rpc: si la función lo llamara, habría lanzado y respondido 500.
    expect(r.body.estado).toBe('reutilizable');
  });
});

describe('01A/01B intactos con la metadata nueva', () => {
  it('payment_intent.succeeded con origen/actor produce la misma acción activar que sin ellos', async () => {
    const { clasificarEvento } = await import('../../netlify/functions/_lib/stripe');
    const base = { id: 'pi_1', customer: 'cus_m1', metadata: { app: 'ekko', usuario_id: 'm1', tier_id: 'tier-pack' } };
    const ev = (o: Record<string, unknown>) => ({ id: 'evt_1', type: 'payment_intent.succeeded', created: 1_700_000_000, data: { object: o } }) as never;
    const con = clasificarEvento(ev({ ...base, metadata: { ...base.metadata, operation_id: OP, ekko_target: 'paquete:tier-pack', origen: 'mostrador', actor_usuario_id: 'u-recep', actor_rol: 'recepcionista' } }));
    expect(con).toEqual(clasificarEvento(ev(base)));
    expect(con.kind).toBe('activar');
  });
});
