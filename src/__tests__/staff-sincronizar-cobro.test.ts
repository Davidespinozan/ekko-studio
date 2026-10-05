import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * R2-B (PKG-01P) · `staff-sincronizar-cobro`: ejecuta YA las operaciones de
 * cobro pendientes de un miembro (p. ej. la cancelación tras una revocación
 * hecha desde el panel). No decide qué operación: solo de quién. Staff activo,
 * mismo estudio.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockEjecutar = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) }))
  }))
}));
vi.mock('../../netlify/functions/_lib/operacionesSuscripcion', () => ({
  ejecutarOperacionesSuscripcion: (...a: unknown[]) => mockEjecutar(...a)
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: vi.fn().mockResolvedValue(undefined) }));

import { handler } from '../../netlify/functions/staff-sincronizar-cobro/index';

type AnyEvent = Parameters<typeof handler>[0];
const invocar = async (body: unknown, headers: Record<string, string> = { authorization: 'Bearer tok' }) => {
  const res = (await handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) } as unknown as AnyEvent, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
};

const ADMIN = { id: 'u-admin', tenant_id: 't1', rol: 'admin', status: 'activo' };

beforeEach(() => {
  vi.clearAllMocks();
  mockMaybeSingle.mockReset();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockEjecutar.mockResolvedValue({ procesadas: 1, aplicadas: 1, fallidas: 0, descartadas: 0, sin_stripe: false });
});

describe('staff-sincronizar-cobro', () => {
  it('staff activo + cuenta de su estudio → ejecuta las operaciones de ESE usuario y devuelve el resumen', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: ADMIN, error: null }).mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 't1' }, error: null });
    const r = await invocar({ usuario_id: 'm1' });
    expect(r.status).toBe(200);
    expect(mockEjecutar).toHaveBeenCalledTimes(1);
    expect(mockEjecutar.mock.calls[0][1]).toEqual({ usuarioId: 'm1' });
    expect(r.body).toMatchObject({ success: true, cobro_stripe: { aplicadas: 1 } });
  });

  it('cuenta de OTRO estudio → 403; inexistente → 404; nunca ejecuta', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: ADMIN, error: null }).mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 'otro' }, error: null });
    expect((await invocar({ usuario_id: 'm1' })).status).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: ADMIN, error: null }).mockResolvedValueOnce({ data: null, error: null });
    expect((await invocar({ usuario_id: 'm1' })).status).toBe(404);
    expect(mockEjecutar).not.toHaveBeenCalled();
  });

  it('miembro o staff revocado → 403; sin token → 401; sin usuario_id → 400', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...ADMIN, rol: 'miembro' }, error: null });
    expect((await invocar({ usuario_id: 'm1' })).status).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...ADMIN, status: 'revocado' }, error: null });
    expect((await invocar({ usuario_id: 'm1' })).status).toBe(403);
    expect((await invocar({ usuario_id: 'm1' }, {})).status).toBe(401);
    expect((await invocar({})).status).toBe(400);
    expect(mockEjecutar).not.toHaveBeenCalled();
  });

  it('el ejecutor revienta → 500 genérico (la revocación ya quedó hecha en la base)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: ADMIN, error: null }).mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 't1' }, error: null });
    mockEjecutar.mockRejectedValue(new Error('boom'));
    const r = await invocar({ usuario_id: 'm1' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('boom');
  });
});
