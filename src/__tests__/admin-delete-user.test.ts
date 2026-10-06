import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06A · admin-delete-user (D-FIN-1 = A): la guardia, la evidencia y el DELETE
 * local viven en la RPC `cuenta_eliminar` (una transacción). La función solo
 * autentica, traduce `permitido=false` a un 409 humano y borra la cuenta de Auth
 * DESPUÉS; si eso falla, lo dice en vez de fingir.
 */

const mockGetUser = vi.fn();
const mockDeleteAuth = vi.fn();
const mockRpc = vi.fn();
const mockMaybe = vi.fn();
const mockReportar = vi.fn().mockResolvedValue(undefined);

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser, admin: { deleteUser: mockDeleteAuth } },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybe })) })) }))
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => mockReportar(...a) }));

import { handler } from '../../netlify/functions/admin-delete-user/index';

type AnyEvent = Parameters<typeof handler>[0];
async function invocar(usuario_id = 'm-1') {
  const e = { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ usuario_id, motivo: 'Cuenta de prueba' }) } as unknown as AnyEvent;
  const r = (await handler(e, {} as never)) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}

const ADMIN = { id: 'u-admin', tenant_id: 't1', rol: 'admin', status: 'activo' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null });
  mockMaybe.mockResolvedValue({ data: ADMIN, error: null });
  mockDeleteAuth.mockResolvedValue({ error: null });
  mockRpc.mockResolvedValue({ data: { permitido: true, usuario_id: 'm-1', auth_id: 'auth-m1' }, error: null });
});

describe('admin-delete-user (PKG-06A · D-FIN-1 = A)', () => {
  it('cuenta desechable: la RPC (actor = admin, con motivo) borra el perfil y después se borra la cuenta de Auth', async () => {
    const r = await invocar();
    expect(r.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('cuenta_eliminar', { p_actor_id: 'u-admin', p_usuario_id: 'm-1', p_motivo: 'Cuenta de prueba' });
    expect(mockDeleteAuth).toHaveBeenCalledWith('auth-m1');
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteAuth.mock.invocationCallOrder[0]);
    expect(r.body).toMatchObject({ success: true, acceso_eliminado: true, deleted: { id: 'm-1' } });
  });

  it('con historial durable (membresías, créditos, cobros…) → 409 humano que manda a Revocar; NO se toca Auth', async () => {
    mockRpc.mockResolvedValue({ data: { permitido: false, usuario_id: 'm-1', historial: { membresias: 1, movimientos: 4, pagos: 2 }, huella_staff: {} }, error: null });
    const r = await invocar();
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/1 membresías, 4 movimientos de créditos, 2 cobros registrados/);
    expect(String(r.body.error)).toMatch(/Revocar acceso/);
    expect(r.body).toMatchObject({ historial: { membresias: 1 } });
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('STAFF con huella (check-ins, bitácora) → 409 con mensaje humano, en vez de "Database error deleting user"', async () => {
    mockRpc.mockResolvedValue({ data: { permitido: false, usuario_id: 'r-1', historial: {}, huella_staff: { checkins: 14, bitacora: 5 } }, error: null });
    const r = await invocar('r-1');
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/14 check-ins registrados por esta persona/);
    expect(String(r.body.error)).toMatch(/5 acciones en la bitácora/);
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('último admin (trigger/RPC) → 409; otro tenant → 404; el error crudo nunca llega al cliente', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_ULTIMO_ADMIN: No puedes borrar al único admin activo del estudio. Nombra otro admin primero.' } });
    let r = await invocar('a-2');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'ULTIMO_ADMIN' });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_MIEMBRO_INVALIDO: Usuario no encontrado o de otro estudio' } });
    r = await invocar('x');
    expect(r.status).toBe(404);
    mockRpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected at pg_catalog…' } });
    r = await invocar('x');
    expect(r.status).toBe(500);
    expect(String(r.body.error)).not.toMatch(/deadlock/);
    expect(mockReportar).toHaveBeenCalled();
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('el perfil se borró pero Auth falló → 200 honesto con acceso_eliminado=false (la fila ya no existe; el siguiente alta limpia Auth)', async () => {
    mockDeleteAuth.mockResolvedValue({ error: { message: 'auth caído' } });
    const r = await invocar();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, acceso_eliminado: false });
    expect(String(r.body.aviso)).toMatch(/no se pudo borrar/);
    expect(mockReportar).toHaveBeenCalled();
  });

  it('perfil sin acceso (auth_id null): solo la RPC, sin llamar a Auth', async () => {
    mockRpc.mockResolvedValue({ data: { permitido: true, usuario_id: 'm-1', auth_id: null }, error: null });
    const r = await invocar();
    expect(r.status).toBe(200);
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('un admin REVOCADO no elimina a nadie (403); a sí mismo → 400; nada llega a la RPC', async () => {
    mockMaybe.mockResolvedValue({ data: { ...ADMIN, status: 'revocado' }, error: null });
    expect((await invocar()).status).toBe(403);
    mockMaybe.mockResolvedValue({ data: ADMIN, error: null });
    expect((await invocar('u-admin')).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });
});
