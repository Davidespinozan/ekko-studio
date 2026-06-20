import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * stripe-portal: deriva el customer de la membresía del propio miembro (nunca
 * del body) y crea una sesión del Customer Portal. Sin suscripción → 400.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockMemMaybe = vi.fn();
const mockPortalCreate = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'membresias') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              not: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(() => ({ maybeSingle: mockMemMaybe })) })) }))
            }))
          }))
        };
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
const invocar = async () =>
  (await handler(evento(), {} as never, () => {})) as { statusCode: number; body: string };

describe('stripe-portal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    mockSocioMaybe.mockResolvedValue({ data: { id: 'u1' }, error: null });
  });

  it('sin Stripe → stripe_pendiente', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await invocar();
    expect(JSON.parse(res.body).reason).toBe('stripe_pendiente');
  });

  it('sin customer en la membresía → 400', async () => {
    mockMemMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('con customer → devuelve { url } del portal', async () => {
    mockMemMaybe.mockResolvedValue({ data: { stripe_customer_id: 'cus_1' }, error: null });
    mockPortalCreate.mockResolvedValue({ url: 'https://portal.stripe/x' });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://portal.stripe/x');
    expect(mockPortalCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_1' }));
  });
});
