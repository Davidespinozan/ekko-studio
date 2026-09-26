import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * admin-update-role y admin-seed-demo (SALA_PARITY_AUDIT_2 · P0-2 / P0-4):
 *  - un admin REVOCADO no opera aunque conserve su sesión;
 *  - ascender a staff a un miembro `pendiente_*` lo deja activo (si no, nace sin
 *    poderes: is_admin()/is_recepcionista() exigen status='activo');
 *  - un admin no se cambia el rol a sí mismo;
 *  - las cuentas demo NUNCA llevan una contraseña fija.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockRpc = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUserById = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    const chain: Record<string, unknown> = { maybeSingle: mockMaybeSingle };
    chain.eq = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    return {
      auth: {
        getUser: mockGetUser,
        admin: {
          createUser: mockCreateUser,
          updateUserById: mockUpdateUserById,
          deleteUser: vi.fn().mockResolvedValue({ error: null })
        }
      },
      rpc: mockRpc,
      from: vi.fn(() => ({
        select: vi.fn(() => chain),
        update: mockUpdate,
        delete: vi.fn(() => chain)
      }))
    };
  })
}));

import { handler as updateRole } from '../../netlify/functions/admin-update-role/index';
import { handler as seedDemo, generarPasswordDemo } from '../../netlify/functions/admin-seed-demo/index';

type AnyEvent = Parameters<typeof updateRole>[0];
const evento = (body: unknown): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) }) as unknown as AnyEvent;
const invocar = async (h: typeof updateRole, e: AnyEvent) =>
  (await h(e, {} as never)) as { statusCode: number; body: string };

const ADMIN = { id: 'u-admin', tenant_id: 't1', rol: 'admin', status: 'activo' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null });
  mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  mockRpc.mockResolvedValue({ data: 2, error: null });
});

describe('admin-update-role', () => {
  it('un admin REVOCADO no puede cambiar roles (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...ADMIN, status: 'revocado' }, error: null });
    const res = await invocar(updateRole, evento({ usuario_id: 'm-1', rol: 'admin' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('un admin no se cambia el rol a sí mismo (400)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: ADMIN, error: null })
      .mockResolvedValueOnce({ data: { ...ADMIN, email: 'a@e.mx' }, error: null });
    const res = await invocar(updateRole, evento({ usuario_id: 'u-admin', rol: 'recepcionista' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('ascender a recepcionista a un miembro pendiente_pago lo deja ACTIVO', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: ADMIN, error: null })
      .mockResolvedValueOnce({
        data: { id: 'm-1', tenant_id: 't1', rol: 'miembro', email: 'm@e.mx', status: 'pendiente_pago' },
        error: null
      });
    const res = await invocar(updateRole, evento({ usuario_id: 'm-1', rol: 'recepcionista' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ rol: 'recepcionista', status: 'activo' });
  });

  it('cambiarle el rol a un REVOCADO no lo reactiva', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: ADMIN, error: null })
      .mockResolvedValueOnce({
        data: { id: 'r-1', tenant_id: 't1', rol: 'recepcionista', email: 'r@e.mx', status: 'revocado' },
        error: null
      });
    const res = await invocar(updateRole, evento({ usuario_id: 'r-1', rol: 'admin' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ rol: 'admin' });
  });
});

describe('admin-seed-demo — sin contraseña fija', () => {
  it('el código fuente no contiene ninguna contraseña literal', () => {
    const src = readFileSync(
      resolve(__dirname, '../../netlify/functions/admin-seed-demo/index.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/DemoEkko/);
    expect(src).not.toMatch(/password:\s*['"`]/);
    expect(src).not.toMatch(/PASSWORD\s*=\s*['"`]/);
  });

  it('genera una contraseña distinta cada vez, larga y sin caracteres ambiguos', () => {
    const a = generarPasswordDemo();
    const b = generarPasswordDemo();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(14);
    expect(a).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
  });

  it('un admin REVOCADO no puede crear cuentas demo (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...ADMIN, status: 'revocado' }, error: null });
    const res = await invocar(seedDemo, evento({}));
    expect(res.statusCode).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});
