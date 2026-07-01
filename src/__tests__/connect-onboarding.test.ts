import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * connect-onboarding: solo el admin activo del estudio inicia el onboarding;
 * get-or-create de la cuenta conectada Express + Account Link.
 */

const mockGetUser = vi.fn();
const mockAdminMaybe = vi.fn();
const mockTenantMaybe = vi.fn();
const mockTenantUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockAccountsCreate = vi.fn();
const mockAccountLinksCreate = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockAdminMaybe })) })) };
      }
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTenantMaybe })) })),
        update: vi.fn(() => ({ eq: mockTenantUpdateEq }))
      };
    })
  }))
}));

vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({
    accounts: { create: mockAccountsCreate },
    accountLinks: { create: mockAccountLinksCreate }
  })
}));

import { handler } from '../../netlify/functions/connect-onboarding/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok', origin: 'https://ekko.test' }, body: '{}' } as unknown as AnyEvent);
const invocar = async () => (await handler(evento(), {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantUpdateEq.mockResolvedValue({ error: null });
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1', email: 'a@e.test' } }, error: null });
});

describe('connect-onboarding', () => {
  it('no-admin → 403', async () => {
    mockAdminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'recepcionista', status: 'activo' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(403);
  });

  it('sin Stripe → stripe_pendiente', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    mockAdminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'activo' }, error: null });
    const res = await invocar();
    expect(JSON.parse(res.body).reason).toBe('stripe_pendiente');
  });

  it('sin cuenta previa → crea Express y devuelve link', async () => {
    mockAdminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'activo' }, error: null });
    mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: null }, error: null });
    mockAccountsCreate.mockResolvedValue({ id: 'acct_new' });
    mockAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe/onboard' });

    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://connect.stripe/onboard');
    expect(mockAccountsCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'express' }));
    expect(mockTenantUpdateEq).toHaveBeenCalled();
  });

  it('con cuenta previa → NO crea otra, solo el link', async () => {
    mockAdminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'activo' }, error: null });
    mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: 'acct_existing' }, error: null });
    mockAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe/again' });

    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).toHaveBeenCalledWith(expect.objectContaining({ account: 'acct_existing' }));
  });
});
