import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearStripeFalso, type StripeFalso } from './helpers/stripeFalso';

/**
 * PKG-01C · crear-pago-invitados con `operation_id` (Stripe FALSO): reintento de
 * la misma compra = mismo PaymentIntent; segunda compra legítima = nueva
 * operación; el tope solo aplica a crear (una operación existente se recupera).
 */

const h = vi.hoisted(() => ({
  stripe: null as unknown as StripeFalso,
  reserva: null as Record<string, unknown> | null
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'auth-1' } }, error: null })) },
    from: vi.fn((table: string) => {
      const dato =
        table === 'usuarios' ? { id: 'u1', tenant_id: 't1', rol: 'miembro', email: 'm@e.com' }
        : table === 'reservas' ? h.reserva
        : table === 'recursos' ? { max_invitados_extra: 4 }
        : { config: { reserva: { precio_invitado_extra_centavos: 10000 } } };
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: dato, error: null })) })) })) };
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({ getStripe: () => h.stripe }));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: vi.fn(async () => ({ accountId: 'acct_1', chargesEnabled: true })),
  getOrCreateSocioCustomer: vi.fn(async () => 'cus_1')
}));

import { handler } from '../../netlify/functions/crear-pago-invitados/index';

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OP2 = '9a8b7c6d-5e4f-4a3b-9c1d-0e1f2a3b4c5d';
const invocar = async (body: Record<string, unknown>) => {
  const r = (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.stripe = crearStripeFalso();
  h.reserva = { id: 'res_1', tenant_id: 't1', usuario_id: 'u1', status: 'confirmada', recurso_id: 'rec_1', invitados_extra_pagados: 0, slot_fin: new Date(Date.now() + 86_400_000).toISOString() };
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('crear-pago-invitados · operation_id', () => {
  it('12 · reintento de la misma compra → MISMO PaymentIntent, key estable pi_invitados', async () => {
    const a = await invocar({ reserva_id: 'res_1', cantidad: 2, operation_id: OP });
    const b = await invocar({ reserva_id: 'res_1', cantidad: 2, operation_id: OP });
    expect(a.body).toMatchObject({ estado: 'reutilizable', clientSecret: 'pi_1_secret_x', monto: 20000 });
    expect(b.body.objetoId).toBe('pi_1');
    expect(h.stripe.estado.pis).toHaveLength(1);
    expect(h.stripe.paymentIntents.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `ekko:v1:pi_invitados:acct_1:u1:${OP}`, stripeAccount: 'acct_1' });
    expect(h.stripe.estado.pis[0].metadata).toEqual({
      app: 'ekko', tipo: 'invitados_extra', reserva_id: 'res_1', cantidad: '2', usuario_id: 'u1',
      // PKG-01H: snapshot del precio y del tenant con el que se cobró.
      tenant_id: 't1', precio_unitario_centavos: '10000',
      operation_id: OP, ekko_target: 'invitados:res_1'
    });
  });

  it('13 · segunda compra LEGÍTIMA para la misma reserva (otro operation_id) → objeto nuevo con key nueva', async () => {
    await invocar({ reserva_id: 'res_1', cantidad: 1, operation_id: OP });
    h.stripe.estado.pis[0].status = 'succeeded';
    h.reserva = { ...h.reserva!, invitados_extra_pagados: 1 };
    const b = await invocar({ reserva_id: 'res_1', cantidad: 1, operation_id: OP2 });
    expect(b.body).toMatchObject({ estado: 'reutilizable', objetoId: 'pi_2' });
    expect(h.stripe.paymentIntents.create.mock.calls[1][1].idempotencyKey).toBe(`ekko:v1:pi_invitados:acct_1:u1:${OP2}`);
  });

  it('la operación ya pagada se RECUPERA aunque sus invitados ya cuenten en el tope (ya_pagado, no un 400 falso)', async () => {
    await invocar({ reserva_id: 'res_1', cantidad: 3, operation_id: OP });
    h.stripe.estado.pis[0].status = 'succeeded';
    h.reserva = { ...h.reserva!, invitados_extra_pagados: 3 }; // 3 + 3 > 4
    const b = await invocar({ reserva_id: 'res_1', cantidad: 3, operation_id: OP });
    expect(b.status).toBe(200);
    expect(b.body.estado).toBe('ya_pagado');
    expect(h.stripe.estado.pis).toHaveLength(1);
  });

  it('una operación NUEVA que excede el tope → 400 sin crear nada', async () => {
    h.reserva = { ...h.reserva!, invitados_extra_pagados: 3 };
    const r = await invocar({ reserva_id: 'res_1', cantidad: 2, operation_id: OP });
    expect(r.status).toBe(400);
    expect(h.stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('cambio de cantidad con el mismo operation_id → se cancela el original (reemplazable); no hay segundo objeto', async () => {
    await invocar({ reserva_id: 'res_1', cantidad: 1, operation_id: OP });
    const b = await invocar({ reserva_id: 'res_1', cantidad: 2, operation_id: OP });
    expect(b.body.estado).toBe('reemplazable');
    expect(h.stripe.estado.pis).toHaveLength(1);
    expect(h.stripe.estado.pis[0].status).toBe('canceled');
  });

  it('respuesta perdida → resultado_desconocido; el reintento recupera el MISMO objeto', async () => {
    h.stripe.perderRespuesta();
    expect((await invocar({ reserva_id: 'res_1', cantidad: 2, operation_id: OP })).body.estado).toBe('resultado_desconocido');
    expect((await invocar({ reserva_id: 'res_1', cantidad: 2, operation_id: OP })).body).toMatchObject({ estado: 'reutilizable', objetoId: 'pi_1' });
    expect(h.stripe.estado.pis).toHaveLength(1);
  });

  it('29 · legacy (sin operation_id): sin key propia, marca diagnóstica', async () => {
    const r = await invocar({ reserva_id: 'res_1', cantidad: 2 });
    expect(r.body).toMatchObject({ clientSecret: 'pi_1_secret_x' });
    expect(h.stripe.paymentIntents.create.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_1' });
    expect(h.stripe.estado.pis[0].metadata).toMatchObject({ ekko_op: 'legacy', tipo: 'invitados_extra' });
  });
});
