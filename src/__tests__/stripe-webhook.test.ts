import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Webhook de Stripe: firma, idempotencia (dedupe por event.id + borrado en
 * error para forzar reintento) y dispatch a los RPCs activar/sync.
 * Mantiene los mappers reales (`clasificarEvento`) y mockea solo Stripe + DB.
 */

const mockConstructEvent = vi.fn();
const mockSubRetrieve = vi.fn().mockResolvedValue({ current_period_end: 1_700_000_000 });
const mockUpsertSelect = vi.fn();
const mockRpc = vi.fn();
const mockDeleteEq = vi.fn().mockResolvedValue({ error: null });
// tenants: lookup por stripe_account_id (cuenta ajena) + update (account.updated)
const mockTenantMaybeSingle = vi.fn();
const mockTenantUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockTenantUpdate = vi.fn(() => ({ eq: mockTenantUpdateEq }));

// Cadena de query encadenable + thenable (para .select().eq().in().not()… y
// .maybeSingle()). Por defecto resuelve data vacía (sin subs previas ni emails).
function makeChain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'gte']) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve({ data: null, error: null });
  c.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb);
  return c;
}

vi.mock('../../netlify/functions/_lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../netlify/functions/_lib/stripe')>()),
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockSubRetrieve }
  })
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      if (table === 'tenants') {
        const c = makeChain();
        c.maybeSingle = () => mockTenantMaybeSingle();
        return { select: () => c, update: mockTenantUpdate };
      }
      return {
        upsert: vi.fn(() => ({ select: mockUpsertSelect })),
        delete: vi.fn(() => ({ eq: mockDeleteEq })),
        select: vi.fn(() => makeChain())
      };
    })
  }))
}));

import { handler } from '../../netlify/functions/stripe-webhook/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(): AnyEvent {
  return {
    httpMethod: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{"raw":true}',
    isBase64Encoded: false
  } as unknown as AnyEvent;
}
async function invocar() {
  return (await handler(evento(), {} as never, () => {})) as { statusCode: number; body: string };
}

describe('stripe-webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockRpc.mockResolvedValue({ data: {}, error: null });
    mockUpsertSelect.mockResolvedValue({ data: [{ id: 'evt_1' }], error: null }); // evento nuevo
    mockTenantMaybeSingle.mockResolvedValue({ data: { id: 'tenant-1' }, error: null }); // cuenta conocida
  });

  it('sin secret → no-op', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await invocar();
    expect(JSON.parse(res.body).skipped).toBe('stripe_no_configurado');
  });

  it('firma inválida → 400', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('evento duplicado → no reprocesa', async () => {
    mockUpsertSelect.mockResolvedValue({ data: [], error: null }); // ya existía
    mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'invoice.paid', created: 1, data: { object: { subscription: 'sub_1' } } });
    const res = await invocar();
    expect(JSON.parse(res.body).duplicate).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('checkout.session.completed → activar_membresia', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_1', undefined);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: 'sub_1', p_stripe_customer_id: 'cus_1'
    }));
  });

  it('checkout mode payment (paquete) → activar sin retrieve de suscripción', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { mode: 'payment', subscription: null, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockSubRetrieve).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: null, p_periodo_fin: null
    }));
  });

  it('invoice.paid 1ª factura → activar_membresia leyendo metadata de la suscripción', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'invoice.paid', created: 1700000000,
      data: { object: { subscription: 'sub_1', billing_reason: 'subscription_create' } }
    });
    mockSubRetrieve.mockResolvedValue({
      current_period_end: 1700000000, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: 'sub_1'
    }));
  });

  it('customer.subscription.updated → sync_membresia_stripe', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000,
      data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: false } }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({
      p_stripe_subscription_id: 'sub_1', p_estado: 'past_due'
    }));
  });

  it('si el RPC falla → borra idempotencia y 500 (para que Stripe reintente)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'invoice.paid', created: 1, data: { object: { subscription: 'sub_1' } }
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await invocar();
    expect(res.statusCode).toBe(500);
    expect(mockDeleteEq).toHaveBeenCalledWith('id', 'evt_1');
  });

  describe('Connect · cuenta compartida', () => {
    const evConCuenta = (account: string) => ({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000, account,
      data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: false, metadata: { app: 'ekko' } } }
    });

    it('evento de una cuenta conectada de EKKO → se procesa sobre esa cuenta', async () => {
      mockConstructEvent.mockReturnValue(evConCuenta('acct_ekko'));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({ p_stripe_subscription_id: 'sub_1' }));
    });

    it('evento de una cuenta que NO es de ningún estudio (gym de SALA) → 200 ignorado, sin RPC ni idempotencia', async () => {
      mockTenantMaybeSingle.mockResolvedValue({ data: null, error: null });
      mockConstructEvent.mockReturnValue(evConCuenta('acct_sala'));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('cuenta_ajena');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpsertSelect).not.toHaveBeenCalled();
    });

    it('objeto con metadata.app de otra app → 200 ignorado (app_ajena), sin RPC', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_1', amount: 1000, customer: 'cus_1', metadata: { app: 'sala', usuario_id: 'u1', tier_id: 't1' } } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('app_ajena');
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('account.updated → refresca stripe_charges_enabled/details_submitted del tenant', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'account.updated', created: 1700000000, account: 'acct_ekko',
        data: { object: { id: 'acct_ekko', charges_enabled: true, details_submitted: true, payouts_enabled: true } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockTenantUpdate).toHaveBeenCalledWith({ stripe_charges_enabled: true, stripe_details_submitted: true });
      expect(mockTenantUpdateEq).toHaveBeenCalledWith('stripe_account_id', 'acct_ekko');
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});
