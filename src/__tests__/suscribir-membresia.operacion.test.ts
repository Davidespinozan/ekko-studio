import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearStripeFalso, type StripeFalso } from './helpers/stripeFalso';

/**
 * PKG-01C · suscribir-membresia (Checkout) con `operation_id` (Stripe FALSO):
 * reintento → misma sesión; drift → se EXPIRA (no puede completarse) y queda
 * reemplazable; estados clasificados sin conceder entitlement (eso es 01B).
 */

const h = vi.hoisted(() => ({ stripe: null as unknown as StripeFalso, tier: null as Record<string, unknown> | null }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'auth-m1' } }, error: null })) },
    from: vi.fn((table: string) => {
      if (table === 'tiers') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: h.tier, error: null })) })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { id: 'm1', tenant_id: 't1', rol: 'miembro', email: 'm@e.test' }, error: null })) })) })) };
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({ getStripe: () => h.stripe }));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: vi.fn(async () => ({ accountId: 'acct_1', chargesEnabled: true })),
  getOrCreateSocioCustomer: vi.fn(async () => 'cus_1')
}));

import { handler } from '../../netlify/functions/suscribir-membresia/index';

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const TIER = { id: 'tier1', slug: 'pro', activo: true, tenant_id: 't1', nombre: 'Pro', precio_centavos: 120000, moneda: 'MXN', tipo: 'tiempo' };
const invocar = async (body: Record<string, unknown>) => {
  const r = (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok', origin: 'https://ekko.test' }, body: JSON.stringify(body) } as never, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.stripe = crearStripeFalso();
  h.tier = { ...TIER };
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('suscribir-membresia · Checkout con operation_id', () => {
  it('15 · reintento → MISMA sesión; key estable cs_mensual; metadata con operación y target', async () => {
    const a = await invocar({ tier: 'pro', embedded: true, operation_id: OP });
    const b = await invocar({ tier: 'pro', embedded: true, operation_id: OP });
    expect(a.body).toMatchObject({ estado: 'reutilizable', client_secret: 'cs_1_secret', account: 'acct_1' });
    expect(b.body.objetoId).toBe('cs_1');
    expect(h.stripe.estado.sesiones).toHaveLength(1);
    const [params, opts] = h.stripe.checkout.sessions.create.mock.calls[0];
    expect(opts).toMatchObject({ idempotencyKey: `ekko:v1:cs_mensual:acct_1:m1:${OP}`, stripeAccount: 'acct_1' });
    expect(params.metadata).toMatchObject({ operation_id: OP, ekko_target: 'checkout_mensual:tier1', tier_id: 'tier1' });
    expect(params.subscription_data.metadata).toMatchObject({ operation_id: OP });
  });

  it('drift (precio) sobre sesión abierta → se EXPIRA y queda reemplazable; no hay segunda sesión', async () => {
    await invocar({ tier: 'pro', operation_id: OP });
    h.tier = { ...TIER, precio_centavos: 150000 };
    const b = await invocar({ tier: 'pro', operation_id: OP });
    expect(b.body.estado).toBe('reemplazable');
    expect(h.stripe.estado.sesiones).toHaveLength(1);
    expect(h.stripe.estado.sesiones[0].status).toBe('expired');
  });

  it('complete + paid → ya_pagado; complete + unpaid → en_proceso; no_payment_required → requiere_revision', async () => {
    await invocar({ tier: 'pro', operation_id: OP });
    const s = h.stripe.estado.sesiones[0];
    s.status = 'complete';
    s.payment_status = 'paid';
    expect((await invocar({ tier: 'pro', operation_id: OP })).body.estado).toBe('ya_pagado');
    s.payment_status = 'unpaid';
    expect((await invocar({ tier: 'pro', operation_id: OP })).body.estado).toBe('en_proceso');
    s.payment_status = 'no_payment_required';
    expect((await invocar({ tier: 'pro', operation_id: OP })).body.estado).toBe('requiere_revision');
    expect(h.stripe.estado.sesiones).toHaveLength(1);
  });

  it('hosted: reutilizable devuelve la URL de la misma sesión', async () => {
    const a = await invocar({ tier: 'pro', embedded: false, operation_id: OP });
    expect(a.body).toMatchObject({ estado: 'reutilizable', url: 'https://checkout.stripe.test/cs_1' });
  });

  it('legacy (sin operation_id): sin key propia y metadata diagnóstica', async () => {
    const a = await invocar({ tier: 'pro', embedded: true });
    expect(a.body).toEqual({ activated: false, client_secret: 'cs_1_secret', account: 'acct_1' });
    expect(h.stripe.checkout.sessions.create.mock.calls[0][1]).toEqual({ stripeAccount: 'acct_1' });
    expect(h.stripe.checkout.sessions.create.mock.calls[0][0].metadata).toMatchObject({ ekko_op: 'legacy' });
  });
});
