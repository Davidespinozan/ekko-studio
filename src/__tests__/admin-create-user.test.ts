import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * admin-create-user (Fase 1 identidad): crea la cuenta en Auth y espera que el
 * trigger deje (o vincule) la fila en `usuarios`. Si el UPDATE por auth_id no
 * encuentra fila, antes respondía 200 dejando una cuenta de acceso sin perfil.
 */

const mockGetUser = vi.fn();
const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockAdminMaybe = vi.fn();
const mockUpdateMaybe = vi.fn();
const mockAviso = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser, admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockAdminMaybe })) })),
      update: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn(() => ({ maybeSingle: mockUpdateMaybe })) })) }))
    }))
  }))
}));
vi.mock('../../netlify/functions/_lib/acceso', () => ({ avisarCambiarPassword: (...a: unknown[]) => mockAviso(...a) }));

import { handler } from '../../netlify/functions/admin-create-user/index';

const invocar = async (body: unknown) =>
  (await handler(
    { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never,
    {} as never,
    () => {}
  )) as { statusCode: number; body: string };

const ADMIN = { id: 'a1', tenant_id: 't1', rol: 'admin', status: 'activo' };
const BODY = { email: 'Nuevo@EKKO.mx', password: 'secreta123', nombre: 'Nuevo', rol: 'miembro' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null });
  mockAdminMaybe.mockResolvedValue({ data: ADMIN, error: null });
  mockCreateUser.mockResolvedValue({ data: { user: { id: 'auth-nuevo' } }, error: null });
  mockDeleteUser.mockResolvedValue({ error: null });
  mockAviso.mockResolvedValue(undefined);
});

describe('admin-create-user', () => {
  it('alta normal: crea en Auth (correo normalizado), encuentra el perfil y avisa cambiar clave', async () => {
    mockUpdateMaybe.mockResolvedValue({ data: { id: 'u-nuevo' }, error: null });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(200);
    expect(mockCreateUser.mock.calls[0][0]).toMatchObject({ email: 'nuevo@ekko.mx' });
    expect(mockAviso).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ usuario_id: 'u-nuevo' }));
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it('sin perfil final (UPDATE vacío, sin error) → 500 y se revierte la cuenta de Auth; NUNCA falso éxito', async () => {
    mockUpdateMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(500);
    expect(mockDeleteUser).toHaveBeenCalledWith('auth-nuevo');
    expect(mockAviso).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).error).toMatch(/no quedó vinculada/i);
  });

  it('error del UPDATE → 500 y revierte', async () => {
    mockUpdateMaybe.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(500);
    expect(mockDeleteUser).toHaveBeenCalledWith('auth-nuevo');
  });

  it('correo ya registrado en Auth → 400 sin borrar nada', async () => {
    mockCreateUser.mockResolvedValue({ data: null, error: { message: 'User already registered' } });
    const res = await invocar(BODY);
    expect(res.statusCode).toBe(400);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});
