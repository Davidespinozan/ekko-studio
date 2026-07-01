import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * stripe-portal (Connect): el customer del miembro vive en la cuenta conectada
 * del estudio; el Customer Portal se crea SOBRE esa cuenta ({ stripeAccount }).
 * Sin customer o sin cuenta del estudio → 400.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockDpMaybe = vi.fn();
const mockTenantMaybe = vi.fn();
const mockPortalCreate = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'usuarios_datos_privados') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockDpMaybe })) })) };
      }
      if (table === 'tenants') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTenantMaybe })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockSocioMaybe })) })) };
    })
  }))
}));

vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({ billingPortal: { sessions: { create: mockPortalCreate } } })
}));

import { handler } from '../../netlify/functions/stripe-portal/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '{}' } as unknown as AnyEvent);
const invocar = async () => (await handler(evento(), {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockSocioMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1' }, error: null });
});

describe('stripe-portal', () => {
  it('sin Stripe → stripe_pendiente', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await invocar();
    expect(JSON.parse(res.body).reason).toBe('stripe_pendiente');
  });

  it('sin customer del miembro → 400', async () => {
    mockDpMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('con customer + cuenta conectada → { url } sobre la cuenta conectada', async () => {
    mockDpMaybe.mockResolvedValue({ data: { stripe_customer_id: 'cus_1' }, error: null });
    mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: 'acct_1' }, error: null });
    mockPortalCreate.mockResolvedValue({ url: 'https://portal.stripe/x' });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://portal.stripe/x');
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1' }),
      { stripeAccount: 'acct_1' }
    );
  });
});
