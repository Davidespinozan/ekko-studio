import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * connect-onboarding: solo el admin activo del estudio inicia el onboarding;
 * get-or-create de la cuenta conectada Express + Account Link.
 */

const mockGetUser = vi.fn();
const mockAdminMaybe = vi.fn();
const mockTenantMaybe = vi.fn();
const mockTenantUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockTenantUpdate = vi.fn(() => ({ eq: mockTenantUpdateEq }));
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
        update: mockTenantUpdate
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
    // PKG-01C (C16): key estable por tenant → un reintento devuelve la MISMA cuenta Express.
    expect(mockAccountsCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'express' }), { idempotencyKey: 'ekko:v1:acct:t1' });
    expect(mockTenantUpdateEq).toHaveBeenCalled();
  });

  it('27 · si no se pudo guardar la cuenta → 500 humano; el reintento usa la MISMA key (misma cuenta, no otra)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAdminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'activo' }, error: null });
    mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: null }, error: null });
    mockAccountsCreate.mockResolvedValue({ id: 'acct_new' });
    mockAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe/onboard' });
    mockTenantUpdateEq.mockResolvedValueOnce({ error: { code: '42501', message: 'permission denied' } });

    const r1 = await invocar();
    expect(r1.statusCode).toBe(500);
    expect(JSON.parse(r1.body).error).toMatch(/No pudimos guardar la cuenta de cobros/);
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();

    const r2 = await invocar();
    expect(r2.statusCode).toBe(200);
    const keys = mockAccountsCreate.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(['ekko:v1:acct:t1', 'ekko:v1:acct:t1']);
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

  it('PKG-01G · cuenta desautorizada → se crea una nueva, se limpia la marca y el gate arranca apagado (el id viejo queda en audit/eventos)', async () => {
    mockAdminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'activo' }, error: null });
    mockTenantMaybe.mockResolvedValue({ data: { stripe_account_id: 'acct_viejo', stripe_desconectado_at: '2026-10-02T10:00:00Z' }, error: null });
    mockAccountsCreate.mockResolvedValue({ id: 'acct_nuevo' });
    mockAccountLinksCreate.mockResolvedValue({ url: 'https://connect.stripe/new' });

    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockAccountsCreate).toHaveBeenCalledTimes(1);
    expect(mockTenantUpdate).toHaveBeenCalledWith({ stripe_account_id: 'acct_nuevo', stripe_desconectado_at: null, stripe_charges_enabled: false, stripe_details_submitted: false });
    expect(mockAccountLinksCreate).toHaveBeenCalledWith(expect.objectContaining({ account: 'acct_nuevo' }));
  });
});
