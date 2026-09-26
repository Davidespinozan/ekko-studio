import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * crear-pago-intent (Fase 1 identidad): un miembro SANCIONADO por el estudio no
 * puede pagar un plan (el cobro crearía la membresía y la cuenta seguiría
 * suspendida). Una pausa (suspendido sin sanción) sí puede.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockTierMaybe = vi.fn();
const mockGetOrCreate = vi.fn();
const mockResolver = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'tiers') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTierMaybe })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockSocioMaybe })) })) };
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({ paymentIntents: { create: vi.fn() }, subscriptions: { create: vi.fn() }, prices: { create: vi.fn() } }),
  llavePrecio: () => 'k'
}));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: (...a: unknown[]) => mockResolver(...a),
  getOrCreateSocioCustomer: (...a: unknown[]) => mockGetOrCreate(...a)
}));

import { handler } from '../../netlify/functions/crear-pago-intent/index';

const invocar = async (body: unknown) =>
  (await handler(
    { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never,
    {} as never,
    () => {}
  )) as { statusCode: number; body: string };

const SOCIO = { id: 'm1', tenant_id: 't1', rol: 'miembro', email: 'm@e.test', status: 'activo', sancionado_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-m1' } }, error: null });
  mockResolver.mockResolvedValue({ accountId: 'acct_1', chargesEnabled: true });
  mockGetOrCreate.mockResolvedValue('cus_1');
  mockTierMaybe.mockResolvedValue({ data: null, error: null }); // el tier no importa: se corta antes
});

describe('crear-pago-intent · sanción', () => {
  it('sancionado → 403 sin crear customer', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { ...SOCIO, status: 'suspendido', sancionado_at: '2026-09-01T00:00:00Z' }, error: null });
    const res = await invocar({ tier: 'pro' });
    expect(res.statusCode).toBe(403);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it('revocado → 403', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { ...SOCIO, status: 'revocado' }, error: null });
    expect((await invocar({ tier: 'pro' })).statusCode).toBe(403);
  });

  it('en pausa (suspendido sin sanción) pasa el guard (sigue al tier)', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { ...SOCIO, status: 'suspendido' }, error: null });
    const res = await invocar({ tier: 'pro' });
    expect(res.statusCode).not.toBe(403);
    expect(mockTierMaybe).toHaveBeenCalled();
  });
});
