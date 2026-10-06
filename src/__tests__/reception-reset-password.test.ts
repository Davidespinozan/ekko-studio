import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06A · `reception-reset-password`: Auth primero (no es transaccional con
 * Postgres), después la RPC `cuenta_password_reseteada` (aviso cambiar_password +
 * audit con actor, en una transacción). Un fallo de la RPC no convierte un reset
 * exitoso en un falso "no se pudo": se entrega la contraseña y se dice que la
 * evidencia no quedó. NUNCA la contraseña a la base ni a los logs.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdateUserById = vi.fn();
const mockRpc = vi.fn();
const mockReportar = vi.fn().mockResolvedValue(undefined);

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { updateUserById: mockUpdateUserById }
    },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) }))
    }))
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => mockReportar(...a) }));

import { handler } from '../../netlify/functions/reception-reset-password/index';

type AnyEvent = Parameters<typeof handler>[0];

function evento(body: unknown): AnyEvent {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify(body)
  } as unknown as AnyEvent;
}

async function invocar(event: AnyEvent) {
  const res = await handler(event, {} as never, () => {});
  return res as { statusCode: number; body: string };
}

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
const TARGET = { id: 'm-1', auth_id: 'auth-m1', tenant_id: 't1', email: 'ana@cravia.mx', rol: 'miembro' };
const ADMIN_CALLER = { id: 'u-admin', tenant_id: 't1', rol: 'admin', status: 'activo' };
const STAFF_TARGET = { id: 's-1', auth_id: 'auth-s1', tenant_id: 't1', email: 'jefe@cravia.mx', rol: 'admin', status: 'activo' };

describe('reception-reset-password (PKG-06A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockUpdateUserById.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: { success: true, usuario_id: 'm-1' }, error: null });
  });

  it('recepcionista resetea → Auth y DESPUÉS la RPC con actor, target y motivo; devuelve la contraseña (nunca a la RPC)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });

    const res = await invocar(evento({ usuario_id: 'm-1', motivo: 'Olvidó su clave' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith('auth-m1', expect.objectContaining({ password: expect.any(String) }));
    expect(mockRpc).toHaveBeenCalledWith('cuenta_password_reseteada', { p_actor_id: 'u-recep', p_usuario_id: 'm-1', p_motivo: 'Olvidó su clave' });
    expect(mockUpdateUserById.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
    expect(JSON.stringify(mockRpc.mock.calls[0][1])).not.toContain((mockUpdateUserById.mock.calls[0][1] as { password: string }).password);

    const body = JSON.parse(res.body) as { password?: string; evidencia_registrada?: boolean };
    expect(typeof body.password).toBe('string');
    expect(body.evidencia_registrada).toBe(true);
  });

  it('Auth aceptó pero la RPC falló → 200 verdadero: contraseña entregada, evidencia_registrada=false y aviso; se reporta', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { password?: string; evidencia_registrada?: boolean; aviso?: string };
    expect(typeof body.password).toBe('string');
    expect(body.evidencia_registrada).toBe(false);
    expect(body.aviso).toMatch(/no quedó registrada/);
    expect(mockReportar).toHaveBeenCalled();
  });

  it('Auth falló → 500 sin falso éxito local: la RPC no se llama y el mensaje crudo no sale', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });
    mockUpdateUserById.mockResolvedValue({ error: { message: 'gotrue 502 upstream' } });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).error).not.toMatch(/gotrue/);
  });

  it('un miembro NO puede resetear (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('recepcionista NO puede resetear la clave de un admin/recepcionista (403, sin tocar auth)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: STAFF_TARGET, error: null });
    const res = await invocar(evento({ usuario_id: 's-1' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('un admin SÍ puede resetear la clave del equipo (200 + RPC)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: ADMIN_CALLER, error: null })
      .mockResolvedValueOnce({ data: STAFF_TARGET, error: null });
    const res = await invocar(evento({ usuario_id: 's-1' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith('auth-s1', expect.objectContaining({ password: expect.any(String) }));
    expect(mockRpc).toHaveBeenCalledWith('cuenta_password_reseteada', expect.objectContaining({ p_actor_id: 'u-admin', p_usuario_id: 's-1' }));
  });

  it('ficha sin auth_id → 400 (no hay login que resetear)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: { ...TARGET, auth_id: null }, error: null });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});
