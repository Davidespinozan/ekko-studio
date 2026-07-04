import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * cambiar-plan-suscripcion: swap MENSUAL↔MENSUAL sin re-pedir tarjeta. Re-precio
 * de la suscripción vigente (cobra la tarjeta guardada, proration al próximo
 * período). Debe caer a 'sin_suscripcion' cuando el destino es paquete o no hay
 * suscripción activa — para que el front use el flujo de pago normal.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockTierMaybe = vi.fn();
const mockMemMaybe = vi.fn();
const mockTenantMaybe = vi.fn();
const mockMemUpdate = vi.fn();
const mockUsuariosUpdate = vi.fn();

const mockPriceCreate = vi.fn();
const mockSubRetrieve = vi.fn();
const mockSubUpdate = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockSocioMaybe })) })),
          update: vi.fn(() => ({ eq: mockUsuariosUpdate }))
        };
      }
      if (table === 'tiers') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTierMaybe })) })) })) };
      }
      if (table === 'membresias') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ not: vi.fn(() => ({ in: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: mockMemMaybe })) })) })) })) }))
          })),
          update: vi.fn(() => ({ eq: mockMemUpdate }))
        };
      }
      if (table === 'tenants') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTenantMaybe })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn() })) })) };
    })
  }))
}));

vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({
    prices: { create: mockPriceCreate },
    subscriptions: { retrieve: mockSubRetrieve, update: mockSubUpdate }
  })
}));

import { handler } from '../../netlify/functions/cambiar-plan-suscripcion/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (tier = 'premium'): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ tier }) } as unknown as AnyEvent);
const invocar = async (tier?: string) =>
  (await handler(evento(tier), {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockSocioMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'miembro' }, error: null });
  mockTierMaybe.mockResolvedValue({
    data: { id: 'tier-premium', slug: 'premium', activo: true, tenant_id: 't1', nombre: 'Premium', precio_centavos: 120000, moneda: 'mxn', tipo: 'tiempo' },
    error: null
  });
  mockMemMaybe.mockResolvedValue({ data: { id: 'mem-1', tier_id: 'tier-esencial', status: 'activa', stripe_subscription_id: 'sub_1' }, error: null });
  mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: 'acct_1', stripe_charges_enabled: true }, error: null });
  mockMemUpdate.mockResolvedValue({ error: null });
  mockUsuariosUpdate.mockResolvedValue({ error: null });
  mockPriceCreate.mockResolvedValue({ id: 'price_new' });
  mockSubRetrieve.mockResolvedValue({ items: { data: [{ id: 'si_1' }] } });
  mockSubUpdate.mockResolvedValue({ id: 'sub_1' });
});

describe('cambiar-plan-suscripcion', () => {
  it('destino paquete → sin_suscripcion (front usa PaymentModal)', async () => {
    mockTierMaybe.mockResolvedValue({
      data: { id: 'tier-pack', slug: 'starter', activo: true, tenant_id: 't1', nombre: 'Starter', precio_centavos: 65000, moneda: 'mxn', tipo: 'creditos' },
      error: null
    });
    const res = await invocar('starter');
    expect(JSON.parse(res.body).reason).toBe('sin_suscripcion');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it('sin suscripción vigente → sin_suscripcion', async () => {
    mockMemMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar();
    expect(JSON.parse(res.body).reason).toBe('sin_suscripcion');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it('mismo plan → 400 (no hace swap)', async () => {
    mockMemMaybe.mockResolvedValue({ data: { id: 'mem-1', tier_id: 'tier-premium', status: 'activa', stripe_subscription_id: 'sub_1' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it('cobros no activos → cobros_no_activos', async () => {
    mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: 'acct_1', stripe_charges_enabled: false }, error: null });
    const res = await invocar();
    expect(JSON.parse(res.body).reason).toBe('cobros_no_activos');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it('no miembro → 400', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'admin' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it('happy path: re-precio con proration + tier actualizado server-side', async () => {
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, tier: 'premium' });

    // Re-precio del ítem vigente con proration al próximo período.
    expect(mockSubUpdate).toHaveBeenCalledWith(
      'sub_1',
      expect.objectContaining({
        items: [{ id: 'si_1', price: 'price_new' }],
        proration_behavior: 'create_prorations'
      }),
      { stripeAccount: 'acct_1' }
    );
    // Tier persistido en ambas tablas (el webhook no toca el tier).
    expect(mockMemUpdate).toHaveBeenCalledWith('id', 'mem-1');
    expect(mockUsuariosUpdate).toHaveBeenCalledWith('id', 'u1');
  });

  it('precio recurrente creado sobre la cuenta conectada', async () => {
    await invocar();
    expect(mockPriceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ unit_amount: 120000, recurring: { interval: 'month' } }),
      expect.objectContaining({ stripeAccount: 'acct_1' })
    );
  });
});
