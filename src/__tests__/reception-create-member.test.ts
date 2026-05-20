import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests de seguridad de la Netlify Function `reception-create-member`
 * (Recepción Plus RP-1). El corazón: el gate de rol y que el rol del
 * usuario creado esté hardcodeado a 'miembro' — recepción nunca crea staff.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();
const mockUpdate = vi.fn((_payload: Record<string, unknown>) => ({
  eq: vi.fn().mockResolvedValue({ error: null })
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser }
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: mockMaybeSingle,
      update: mockUpdate
    }))
  }))
}));

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

describe('reception-create-member · seguridad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockCreateUser.mockResolvedValue({ data: { user: { id: 'auth-nuevo' } }, error: null });
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
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
  });

  it('caller sin perfil → 403', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('recepcionista SÍ puede registrar — crea con rol="miembro"', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'u-recep', tenant_id: 'tenant-1', rol: 'recepcionista' },
      error: null
    });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const updatePayload = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updatePayload.rol).toBe('miembro');
    expect(updatePayload.tenant_id).toBe('tenant-1'); // tenant del caller, no del body
    expect(updatePayload.status).toBe('pendiente_pago');
  });

  it('admin también puede usar esta función', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'u-admin', tenant_id: 'tenant-1', rol: 'admin' },
      error: null
    });
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(200);
  });

  it('rol="admin" en el body se IGNORA — siempre crea miembro', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'u-recep', tenant_id: 'tenant-1', rol: 'recepcionista' },
      error: null
    });
    const res = await invocar(evento({ ...BODY_OK, rol: 'admin', tenant_id: 'otro-tenant' }));
    expect(res.statusCode).toBe(200);
    const updatePayload = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updatePayload.rol).toBe('miembro'); // nunca 'admin'
    expect(updatePayload.tenant_id).toBe('tenant-1'); // nunca 'otro-tenant'
  });

  it('password corta → 400 antes de tocar Auth', async () => {
    const res = await invocar(evento({ ...BODY_OK, password: 'corta' }));
    expect(res.statusCode).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});
