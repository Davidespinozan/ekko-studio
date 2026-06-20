import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pagos — `suscribir-membresia` (self-serve). Sin Stripe configurado responde
 * stripe_pendiente (no cobra ni activa). Rechaza tier faltante y no-miembros.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockTierMaybe = vi.fn();

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

import { handler } from '../../netlify/functions/suscribir-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(body: unknown): AnyEvent {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
}
async function invocar(event: AnyEvent) {
  return (await handler(event, {} as never, () => {})) as { statusCode: number; body: string };
}

const SOCIO = { id: 'm1', tenant_id: 't1', rol: 'miembro' };
const TIER = { id: 'tier1', slug: 'pro', stripe_price_id: null, activo: true, tenant_id: 't1' };

describe('suscribir-membresia (Pagos · self-serve)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocioMaybe.mockReset();
    mockTierMaybe.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    delete process.env.STRIPE_SECRET_KEY; // sin Stripe
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-m1' } }, error: null });
  });

  it('sin Stripe → stripe_pendiente (no activa)', async () => {
    mockSocioMaybe.mockResolvedValue({ data: SOCIO, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });
    const res = await invocar(evento({ tier: 'pro' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { activated: boolean; reason: string };
    expect(body.activated).toBe(false);
    expect(body.reason).toBe('stripe_pendiente');
  });

  it('sin tier → 400', async () => {
    const res = await invocar(evento({}));
    expect(res.statusCode).toBe(400);
  });

  it('no-miembro → 400', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { ...SOCIO, rol: 'recepcionista' }, error: null });
    const res = await invocar(evento({ tier: 'pro' }));
    expect(res.statusCode).toBe(400);
  });

  it('tier inválido → 400', async () => {
    mockSocioMaybe.mockResolvedValue({ data: SOCIO, error: null });
    mockTierMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar(evento({ tier: 'fantasma' }));
    expect(res.statusCode).toBe(400);
  });
});
