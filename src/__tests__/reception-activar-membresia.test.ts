import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pagos — `reception-activar-membresia`: activa en mostrador vía el RPC
 * keystone `activar_membresia` + audit_log. Rechaza body inválido, tier
 * inactivo y cross-tenant.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn(); // usuarios (caller, target)
const mockTierMaybe = vi.fn();   // tiers
const mockRpc = vi.fn();
const mockAuditInsert = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      if (table === 'tiers') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTierMaybe })) })) }))
          }))
        };
      }
      // usuarios
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) };
    })
  }))
}));

import { handler } from '../../netlify/functions/reception-activar-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(body: unknown): AnyEvent {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
}
async function invocar(event: AnyEvent) {
  return (await handler(event, {} as never, () => {})) as { statusCode: number; body: string };
}

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista' };
const TARGET = { id: 'm1', tenant_id: 't1', status: 'pendiente_pago', membresia_tier: 'pro' };
const TIER = { id: 'tier1', slug: 'pro' };

describe('reception-activar-membresia (Pagos)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    mockTierMaybe.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockRpc.mockResolvedValue({ data: { success: true, tier: 'pro' }, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('activa: llama al RPC keystone y audita', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });

    const res = await invocar(evento({ usuario_id: 'm1', tier: 'pro' }));
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', { p_usuario_id: 'm1', p_tier_id: 'tier1' });
    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('membership_activated');
    expect(audit.target_id).toBe('m1');
  });

  it('sin tier → 400', async () => {
    const res = await invocar(evento({ usuario_id: 'm1' }));
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('tier inactivo / no encontrado → 400', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar(evento({ usuario_id: 'm1', tier: 'fantasma' }));
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('cross-tenant → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: { ...TARGET, tenant_id: 'otro' }, error: null });
    const res = await invocar(evento({ usuario_id: 'm1', tier: 'pro' }));
    expect(res.statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('un miembro no puede → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento({ usuario_id: 'm1', tier: 'pro' }));
    expect(res.statusCode).toBe(403);
  });
});
