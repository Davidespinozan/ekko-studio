import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06A · admin-create-user: la parte local va por RPC con el admin como actor
 * (`cuenta_alta_preparar` → Auth → `cuenta_alta_finalizar`). Aquí se prueba el
 * ORDEN y la compensación por propiedad: nunca se borra un perfil preexistente
 * como rollback; lo que esta alta creó sí se revierte; el reintento converge.
 */

const mockGetUser = vi.fn();
const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockAdminMaybe = vi.fn();
const mockRpc = vi.fn();
const mockReportar = vi.fn().mockResolvedValue(undefined);

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser, admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockAdminMaybe })) }))
    }))
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => mockReportar(...a) }));

import { handler } from '../../netlify/functions/admin-create-user/index';

const invocar = async (body: unknown) =>
  (await handler(
    { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never,
    {} as never,
    () => {}
  )) as { statusCode: number; body: string };

const ADMIN = { id: 'a1', tenant_id: 't1', rol: 'admin', status: 'activo' };
const BODY = { email: 'Nuevo@EKKO.mx', password: 'secreta123', nombre: 'Nuevo', rol: 'miembro' };
const FIN_OK = { success: true, idempotente: false, usuario_id: 'u-nuevo', rol: 'miembro', status: 'pendiente_pago' };

/** Respuestas de las RPC por nombre (en orden de llamada para cada nombre). */
function rpcPorNombre(resp: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>) {
  mockRpc.mockImplementation((fn: string) => {
    const cola = resp[fn] ?? [];
    const r = cola.length > 1 ? cola.shift() : cola[0];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
  });
}
const llamadas = (fn: string) => mockRpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null });
  mockAdminMaybe.mockResolvedValue({ data: ADMIN, error: null });
  mockCreateUser.mockResolvedValue({ data: { user: { id: 'auth-nuevo' } }, error: null });
  mockDeleteUser.mockResolvedValue({ error: null });
  rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'nueva' } }], cuenta_alta_finalizar: [{ data: FIN_OK }] });
});

describe('admin-create-user (PKG-06A)', () => {
  it('alta nueva: preparar (actor = admin) → Auth con correo normalizado → finalizar modo nueva; responde id + password; no borra nada', async () => {
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(200);
    expect(llamadas('cuenta_alta_preparar')[0]).toMatchObject({ p_actor_id: 'a1', p_email: 'nuevo@ekko.mx', p_rol: 'miembro', p_perfil_id: null });
    expect(mockCreateUser.mock.calls[0][0]).toMatchObject({ email: 'nuevo@ekko.mx', email_confirm: true });
    expect(llamadas('cuenta_alta_finalizar')[0]).toMatchObject({ p_actor_id: 'a1', p_auth_id: 'auth-nuevo', p_rol: 'miembro', p_modo: 'nueva', p_tier: null });
    // preparar antes de Auth, finalizar después.
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockCreateUser.mock.invocationCallOrder[0]);
    expect(mockCreateUser.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[1]);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, modo: 'nueva', recuperada: false, user: { id: 'u-nuevo', password: 'secreta123', rol: 'miembro' } });
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('perfil con historial sin confirmar → 409 ANTES de tocar Auth (no se adueña por el correo)', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'perfil_con_historial', perfil_id: 'p-1', historial: { membresias: 1 } } }] });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ perfil_id: 'p-1', historial: { membresias: 1 } });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('ya existe con acceso → 400; rol distinto al del perfil → 409; ambiguo → 409. Nunca Auth.', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'existente' } }] });
    expect((await invocar(BODY)).statusCode).toBe(400);
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'rol_distinto', rol_perfil: 'miembro' } }] });
    expect((await invocar({ ...BODY, rol: 'admin' })).statusCode).toBe(409);
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'ambiguo' } }] });
    expect((await invocar(BODY)).statusCode).toBe(409);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('perfil_id explícito viaja a preparar (alta sobre ESE perfil) y se finaliza en modo vincular', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'vincular', perfil_id: 'p-1' } }], cuenta_alta_finalizar: [{ data: { ...FIN_OK, usuario_id: 'p-1' } }] });
    const res = await invocar({ ...BODY, perfil_id: 'p-1' });
    expect(res.statusCode).toBe(200);
    expect(llamadas('cuenta_alta_preparar')[0]).toMatchObject({ p_perfil_id: 'p-1' });
    expect(llamadas('cuenta_alta_finalizar')[0]).toMatchObject({ p_modo: 'vincular' });
    expect(JSON.parse(res.body).modo).toBe('vincular');
  });

  it('modo nueva + finalización falla → se revierte SOLO la cuenta de Auth que esta alta creó (el cascarón cae con ella)', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'nueva' } }], cuenta_alta_finalizar: [{ error: { message: 'boom' } }] });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(500);
    expect(mockDeleteUser).toHaveBeenCalledWith('auth-nuevo');
    expect(JSON.parse(res.body).error).toMatch(/se revirtió/i);
    expect(JSON.parse(res.body).error).not.toMatch(/boom/);
  });

  it('modo vincular + finalización falla → NUNCA se borra la cuenta (arrastraría el perfil preexistente); respuesta parcial honesta', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'vincular', perfil_id: 'p-1' } }], cuenta_alta_finalizar: [{ error: { message: 'boom' } }] });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(500);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ parcial: { acceso_creado: true, perfil_finalizado: false } });
    expect(JSON.parse(res.body).error).toMatch(/mismo correo/);
  });

  it('modo nueva + finalización falla + la compensación también falla → 500 honesto con `parcial` (nada se afirma)', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'nueva' } }], cuenta_alta_finalizar: [{ error: { message: 'EKKO_TENANT_DIFERENTE: El perfil es de otro estudio' } }] });
    mockDeleteUser.mockResolvedValue({ error: { message: 'auth caído' } });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ parcial: { acceso_creado: true, perfil_finalizado: false } });
    expect(mockReportar).toHaveBeenCalled();
  });

  it('recuperar: un alta anterior a medias no vuelve a tocar Auth; finaliza con el modo original', async () => {
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'recuperar', modo_original: 'nueva', auth_id: 'auth-viejo' } }], cuenta_alta_finalizar: [{ data: FIN_OK }] });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(200);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(llamadas('cuenta_alta_finalizar')[0]).toMatchObject({ p_auth_id: 'auth-viejo', p_modo: 'nueva' });
    expect(JSON.parse(res.body).recuperada).toBe(true);
  });

  it('el trigger de alta rechaza en Auth (perfil con historial) → 409 con el mensaje del servidor, sin borrar nada', async () => {
    mockCreateUser.mockResolvedValue({ data: null, error: { message: 'Database error: EKKO_PERFIL_CON_HISTORIAL: ya existe un perfil con historial para el correo x' } });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ codigo: 'PERFIL_CON_HISTORIAL' });
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockRpc.mock.calls.some((c) => c[0] === 'cuenta_alta_finalizar')).toBe(false);
  });

  it('Auth dice "ya registrado" sin perfil aquí: si es una cuenta de Auth sin ningún perfil se limpia y se vuelve a crear; si no, 400', async () => {
    mockCreateUser
      .mockResolvedValueOnce({ data: null, error: { message: 'User already registered' } })
      .mockResolvedValueOnce({ data: { user: { id: 'auth-nuevo-2' } }, error: null });
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'nueva' } }], auth_usuario_sin_perfil: [{ data: 'auth-huerfano' }], cuenta_alta_finalizar: [{ data: FIN_OK }] });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(200);
    expect(mockDeleteUser).toHaveBeenCalledWith('auth-huerfano');
    expect(mockCreateUser).toHaveBeenCalledTimes(2);
    expect(llamadas('cuenta_alta_finalizar')[0]).toMatchObject({ p_auth_id: 'auth-nuevo-2' });

    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null });
    mockAdminMaybe.mockResolvedValue({ data: ADMIN, error: null });
    mockCreateUser.mockResolvedValue({ data: null, error: { message: 'User already registered' } });
    rpcPorNombre({ cuenta_alta_preparar: [{ data: { modo: 'nueva' } }], auth_usuario_sin_perfil: [{ data: null }] });
    const res2 = await invocar(BODY);
    expect(res2.statusCode).toBe(400);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('un admin REVOCADO no crea cuentas (403); rol "staff" ya no existe (400)', async () => {
    mockAdminMaybe.mockResolvedValue({ data: { ...ADMIN, status: 'revocado' }, error: null });
    expect((await invocar(BODY)).statusCode).toBe(403);
    mockAdminMaybe.mockResolvedValue({ data: ADMIN, error: null });
    expect((await invocar({ ...BODY, rol: 'staff' })).statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
