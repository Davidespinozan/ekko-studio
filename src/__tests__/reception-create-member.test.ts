import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests de seguridad de la Netlify Function `reception-create-member`
 * (Recepción Plus RP-1). El corazón: el gate de rol y que el rol del
 * usuario creado esté hardcodeado a 'miembro' — recepción nunca crea staff.
 * PKG-06A: la parte local (perfil + auditoría con actor) va por RPC; la
 * evidencia `cuenta_creada` la escribe `cuenta_alta_finalizar`, no la función.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockRpc = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser }
    },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: mockMaybeSingle
    }))
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: vi.fn().mockResolvedValue(undefined) }));

import { handler } from '../../netlify/functions/reception-create-member/index';

type AnyEvent = Parameters<typeof handler>[0];

function evento(body: unknown, headers: Record<string, string> = { authorization: 'Bearer tok' }): AnyEvent {
  return { httpMethod: 'POST', headers, body: JSON.stringify(body) } as unknown as AnyEvent;
}

const BODY_OK = { email: 'nuevo@cravia.mx', password: 'password123', nombre: 'Nuevo Miembro' };

async function invocar(event: AnyEvent) {
  const res = await handler(event, {} as never, () => {});
  return res as { statusCode: number; body: string };
}
const llamadas = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);

describe('reception-create-member · seguridad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockCreateUser.mockResolvedValue({ data: { user: { id: 'auth-nuevo' } }, error: null });
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'cuenta_alta_preparar') return Promise.resolve({ data: { modo: 'nueva' }, error: null });
      if (fn === 'cuenta_alta_finalizar') return Promise.resolve({ data: { success: true, idempotente: false, usuario_id: 'm-new', rol: 'miembro', status: 'pendiente_pago' }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('rechaza método que no sea POST', async () => {
    const res = await invocar({ httpMethod: 'GET', headers: {}, body: null } as unknown as AnyEvent);
    expect(res.statusCode).toBe(400);
  });

  it('rechaza sin bearer token', async () => {
    const res = await invocar(evento(BODY_OK, {}));
    expect(res.statusCode).toBe(401);
  });

  it('un miembro NO puede registrar miembros (403)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'miembro' }, error: null });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('caller sin perfil → 403', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('recepcionista SÍ puede registrar — la RPC recibe rol="miembro" y al caller como actor (el tenant lo fija la RPC)', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'u-recep', tenant_id: 'tenant-1', rol: 'recepcionista', status: 'activo' },
      error: null
    });
    const res = await invocar(evento({ ...BODY_OK, membresia_tier: 'esencial' }));
    expect(res.statusCode).toBe(200);
    expect(llamadas('cuenta_alta_preparar')[0]).toMatchObject({ p_actor_id: 'u-recep', p_rol: 'miembro', p_email: 'nuevo@cravia.mx' });
    expect(llamadas('cuenta_alta_finalizar')[0]).toMatchObject({ p_actor_id: 'u-recep', p_rol: 'miembro', p_tier: 'esencial', p_auth_id: 'auth-nuevo', p_modo: 'nueva' });
    expect(JSON.parse(res.body).user).toMatchObject({ id: 'm-new', rol: 'miembro', status: 'pendiente_pago', password: 'password123' });
  });

  it('admin también puede usar esta función', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'u-admin', tenant_id: 'tenant-1', rol: 'admin', status: 'activo' },
      error: null
    });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(200);
  });

  it('rol="admin" y tenant_id en el body se IGNORAN — siempre miembro, tenant del actor', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'u-recep', tenant_id: 'tenant-1', rol: 'recepcionista', status: 'activo' },
      error: null
    });
    const res = await invocar(evento({ ...BODY_OK, rol: 'admin', tenant_id: 'otro-tenant' }));
    expect(res.statusCode).toBe(200);
    for (const l of [...llamadas('cuenta_alta_preparar'), ...llamadas('cuenta_alta_finalizar')]) {
      expect(l.p_rol).toBe('miembro');
      expect(l).not.toHaveProperty('p_tenant_id');
    }
  });

  it('password corta → 400 antes de tocar Auth', async () => {
    const res = await invocar(evento({ ...BODY_OK, password: 'corta' }));
    expect(res.statusCode).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('un recepcionista REVOCADO no registra aunque conserve su sesión (403)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'revocado' }, error: null });
    expect((await invocar(evento(BODY_OK))).statusCode).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('un perfil con historial para ese correo no se adueña: 409 antes de Auth (PKG-06A)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' }, error: null });
    mockRpc.mockResolvedValueOnce({ data: { modo: 'perfil_con_historial', perfil_id: 'p-9', historial: { reservas: 3 } }, error: null });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).perfil_id).toBe('p-9');
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});
