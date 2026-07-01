import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * suscribir-membresia (Connect): crea un Embedded Checkout sobre la CUENTA
 * CONECTADA del estudio (direct charge). Sin Stripe → stripe_pendiente; sin
 * cobros activados → cobros_no_activos; mensual → mode subscription; paquete →
 * mode payment. Devuelve { client_secret, account }.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockTierMaybe = vi.fn();
const mockSessionCreate = vi.fn();
const mockResolver = vi.fn();
const mockGetOrCreate = vi.fn();

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
  getStripe: () => ({ checkout: { sessions: { create: mockSessionCreate } } })
}));

vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: (...args: unknown[]) => mockResolver(...args),
  getOrCreateSocioCustomer: (...args: unknown[]) => mockGetOrCreate(...args)
}));

import { handler } from '../../netlify/functions/suscribir-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (body: unknown): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent);
const invocar = async (b: unknown) => (await handler(evento(b), {} as never, () => {})) as { statusCode: number; body: string };

const SOCIO = { id: 'm1', tenant_id: 't1', rol: 'miembro', email: 'm@e.test' };
const TIER = { id: 'tier1', slug: 'pro', activo: true, tenant_id: 't1', nombre: 'Pro', precio_centavos: 120000, moneda: 'MXN', tipo: 'tiempo' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-m1', email: 'm@e.test' } }, error: null });
  mockGetOrCreate.mockResolvedValue('cus_1');
  mockResolver.mockResolvedValue({ accountId: 'acct_1', chargesEnabled: true });
});

describe('suscribir-membresia (Connect)', () => {
  it('sin tier → 400', async () => {
    const res = await invocar({});
    expect(res.statusCode).toBe(400);
  });

  it('no-miembro → 400', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { ...SOCIO, rol: 'recepcionista' }, error: null });
    const res = await invocar({ tier: 'pro' });
    expect(res.statusCode).toBe(400);
  });

  it('sin Stripe → stripe_pendiente', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    mockSocioMaybe.mockResolvedValue({ data: SOCIO, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });
    const res = await invocar({ tier: 'pro' });
    expect(JSON.parse(res.body).reason).toBe('stripe_pendiente');
  });

  it('estudio sin cobros activados → cobros_no_activos', async () => {
    mockSocioMaybe.mockResolvedValue({ data: SOCIO, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });
    mockResolver.mockResolvedValue({ accountId: null, chargesEnabled: false });
    const res = await invocar({ tier: 'pro' });
    expect(JSON.parse(res.body).reason).toBe('cobros_no_activos');
  });

  it('mensual → Embedded Checkout mode subscription sobre la cuenta conectada', async () => {
    mockSocioMaybe.mockResolvedValue({ data: SOCIO, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });
    mockSessionCreate.mockResolvedValue({ client_secret: 'cs_test' });
    const res = await invocar({ tier: 'pro', embedded: true });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.client_secret).toBe('cs_test');
    expect(body.account).toBe('acct_1');
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'subscription', ui_mode: 'embedded' }),
      { stripeAccount: 'acct_1' }
    );
  });

  it('paquete → mode payment', async () => {
    mockSocioMaybe.mockResolvedValue({ data: SOCIO, error: null });
    mockTierMaybe.mockResolvedValue({ data: { ...TIER, tipo: 'creditos' }, error: null });
    mockSessionCreate.mockResolvedValue({ client_secret: 'cs_pack' });
    const res = await invocar({ tier: 'pro', embedded: true });
    expect(res.statusCode).toBe(200);
    expect(mockSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'payment' }),
      { stripeAccount: 'acct_1' }
    );
  });
});
