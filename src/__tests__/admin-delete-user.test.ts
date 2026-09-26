import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * admin-delete-user (SALA_PARITY_AUDIT_2 · M6 / B4). Borrar a una persona borra en
 * cascada su fila de `membresias`, pero NO cancela nada en Stripe: antes el único
 * pre-check era "¿tiene reservas?", así que un miembro que pagó y nunca reservó
 * se podía borrar y su tarjeta se seguía cobrando cada mes. Y borrar a un staff
 * con historial tronaba con "Database error deleting user" (FKs sin ON DELETE).
 */

const mockGetUser = vi.fn();
const mockDeleteAuth = vi.fn();
const mockRpc = vi.fn();
/** Respuestas por tabla: `maybe` para .maybeSingle(), `count` para head+count. */
let tablas: Record<string, { maybe?: unknown[]; count?: number | Record<string, number> }>;

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser, admin: { deleteUser: mockDeleteAuth } },
    rpc: mockRpc,
    from: vi.fn((tabla: string) => {
      let columnaFiltro = '';
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'in', 'not', 'limit', 'order']) c[m] = () => c;
      c.eq = (col: string) => {
        columnaFiltro = col;
        return c;
      };
      c.maybeSingle = () => Promise.resolve({ data: tablas[tabla]?.maybe?.shift() ?? null, error: null });
      // await directo sobre la cadena = consulta de conteo (head: true).
      c.then = (cb: (v: unknown) => unknown) => {
        const cfg = tablas[tabla]?.count;
        const count = typeof cfg === 'object' ? cfg[columnaFiltro] ?? 0 : cfg ?? 0;
        return Promise.resolve({ count, error: null }).then(cb);
      };
      c.delete = () => c;
      return c;
    })
  }))
}));

import { handler } from '../../netlify/functions/admin-delete-user/index';

type AnyEvent = Parameters<typeof handler>[0];
async function invocar(usuario_id = 'm-1') {
  const e = { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ usuario_id }) } as unknown as AnyEvent;
  const r = (await handler(e, {} as never)) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}

const ADMIN = { id: 'u-admin', tenant_id: 't1', rol: 'admin', status: 'activo' };
const MIEMBRO = { id: 'm-1', tenant_id: 't1', rol: 'miembro', auth_id: 'auth-m1', email: 'ana@e.mx', nombre: 'Ana' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null });
  mockDeleteAuth.mockResolvedValue({ error: null });
  mockRpc.mockResolvedValue({ data: 2, error: null });
  tablas = { usuarios: { maybe: [ADMIN, MIEMBRO] } };
});

describe('admin-delete-user', () => {
  it('miembro sin historial → se elimina', async () => {
    const r = await invocar();
    expect(r.status).toBe(200);
    expect(mockDeleteAuth).toHaveBeenCalledWith('auth-m1');
  });

  it('con SUSCRIPCIÓN VIVA en Stripe → 409 y NO se borra (la tarjeta se seguiría cobrando)', async () => {
    tablas.membresias = { maybe: [{ id: 'mem-1' }] };
    const r = await invocar();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ suscripcion_viva: true });
    expect(String(r.body.error)).toMatch(/suscripción activa en Stripe/);
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('con COBROS registrados → 409: a quien pagó se le revoca, no se le borra', async () => {
    tablas.payment_events = { count: 3 };
    const r = await invocar();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ pagos_count: 3 });
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('con reservas → 409 (comportamiento previo, se conserva)', async () => {
    tablas.reservas = { count: { usuario_id: 2 } };
    const r = await invocar();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reservas_count: 2 });
  });

  it('STAFF que hizo check-ins → 409 con mensaje humano, en vez de "Database error deleting user"', async () => {
    tablas.usuarios = { maybe: [ADMIN, { ...MIEMBRO, id: 'r-1', rol: 'recepcionista' }] };
    tablas.reservas = { count: { check_in_by: 14 } };
    const r = await invocar('r-1');
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/14 check-ins registrados/);
    expect(String(r.body.error)).toMatch(/Revocar acceso/);
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });

  it('staff con acciones en la bitácora → 409', async () => {
    tablas.usuarios = { maybe: [ADMIN, { ...MIEMBRO, id: 'r-1', rol: 'recepcionista' }] };
    tablas.audit_log = { count: 5 };
    const r = await invocar('r-1');
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/bitácora/);
  });

  it('un admin REVOCADO no puede eliminar a nadie (403)', async () => {
    tablas.usuarios = { maybe: [{ ...ADMIN, status: 'revocado' }] };
    const r = await invocar();
    expect(r.status).toBe(403);
    expect(mockDeleteAuth).not.toHaveBeenCalled();
  });
});
