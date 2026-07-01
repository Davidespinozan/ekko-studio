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
    from: vi.fn(() => ({
      upsert: vi.fn(() => ({ select: mockUpsertSelect })),
      delete: vi.fn(() => ({ eq: mockDeleteEq }))
    }))
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
});
