import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * admin-update-role y admin-seed-demo (SALA_PARITY_AUDIT_2 · P0-2 / P0-4):
 *  - un admin REVOCADO no opera aunque conserve su sesión;
 *  - PKG-06A: el cambio de rol es la RPC `cuenta_cambiar_rol` (actor explícito,
 *    auditoría y último admin en el servidor); la función solo autentica y traduce;
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

vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: vi.fn().mockResolvedValue(undefined) }));

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

describe('admin-update-role (PKG-06A: una transacción del servidor)', () => {
  it('un admin REVOCADO no puede cambiar roles (403): nada llega a la RPC', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...ADMIN, status: 'revocado' }, error: null });
    const res = await invocar(updateRole, evento({ usuario_id: 'm-1', rol: 'admin' }));
    expect(res.statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('el cambio va por `cuenta_cambiar_rol` con el admin como actor; la RPC decide status (pendiente_* → activo al ascender)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: ADMIN, error: null });
    mockRpc.mockResolvedValueOnce({ data: { success: true, idempotente: false, usuario_id: 'm-1', rol: 'recepcionista', status: 'activo' }, error: null });
    const res = await invocar(updateRole, evento({ usuario_id: 'm-1', rol: 'recepcionista' }));
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('cuenta_cambiar_rol', { p_actor_id: 'u-admin', p_usuario_id: 'm-1', p_rol: 'recepcionista' });
    expect(mockUpdate).not.toHaveBeenCalled(); // ya no hay UPDATE suelto con service_role
    expect(JSON.parse(res.body)).toMatchObject({ success: true, rol: 'recepcionista', status: 'activo', idempotente: false });
  });

  it('su propio rol → 400; último admin → 409; otro tenant → 404 (códigos EKKO_* del servidor, texto humano)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: ADMIN, error: null });
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_PROPIO_ROL: No puedes cambiar tu propio rol. Pídeselo a otro admin.' } });
    let res = await invocar(updateRole, evento({ usuario_id: 'u-admin', rol: 'recepcionista' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/propio rol/);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_ULTIMO_ADMIN: No puedes dejar el estudio sin ningún admin activo. Nombra otro admin primero.' } });
    res = await invocar(updateRole, evento({ usuario_id: 'a-2', rol: 'miembro' }));
    expect(res.statusCode).toBe(409);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_MIEMBRO_INVALIDO: Usuario no encontrado o de otro estudio' } });
    res = await invocar(updateRole, evento({ usuario_id: 'x', rol: 'miembro' }));
    expect(res.statusCode).toBe(404);
  });

  it('rol "staff" ya no existe (400 antes de la RPC); un error desconocido no se filtra (500 genérico)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: ADMIN, error: null });
    expect((await invocar(updateRole, evento({ usuario_id: 'm-1', rol: 'staff' }))).statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'could not serialize access' } });
    const res = await invocar(updateRole, evento({ usuario_id: 'm-1', rol: 'admin' }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).not.toMatch(/serialize/);
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
