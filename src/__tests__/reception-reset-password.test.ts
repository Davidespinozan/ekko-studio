import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque A — `reception-reset-password`: escribe audit_log 'password_reset'
 * (sin antes/después, NUNCA la contraseña) y dejó de escribir en notas_admin.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockAuditInsert = vi.fn();
const mockUpdateUserById = vi.fn();
const mockNotifInsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { updateUserById: mockUpdateUserById }
    },
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      if (table === 'notificaciones') return { insert: mockNotifInsert };
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
        update: mockUpdate
      };
    })
  }))
}));

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

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista' };
const TARGET = { id: 'm-1', auth_id: 'auth-m1', tenant_id: 't1', email: 'ana@cravia.mx', rol: 'miembro' };
const ADMIN_CALLER = { id: 'u-admin', tenant_id: 't1', rol: 'admin' };
const STAFF_TARGET = { id: 's-1', auth_id: 'auth-s1', tenant_id: 't1', email: 'jefe@cravia.mx', rol: 'admin' };

describe('reception-reset-password · audit (Bloque A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockUpdateUserById.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  });

  it('recepcionista resetea → 200 + audit password_reset, sin tocar notas_admin', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });

    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(200);

    // audit_log password_reset, sin antes/después.
    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('password_reset');
    expect(audit.target_id).toBe('m-1');
    expect(audit.antes ?? null).toBeNull();
    expect(audit.despues ?? null).toBeNull();

    // Ya NO escribe notas_admin (no hay update a usuarios).
    expect(mockUpdate).not.toHaveBeenCalled();

    // El password no se loguea; sí se devuelve para entregar en mostrador.
    const body = JSON.parse(res.body) as { password?: string };
    expect(typeof body.password).toBe('string');
  });

  it('un miembro NO puede resetear (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('recepcionista NO puede resetear la clave de un admin/recepcionista (403, sin tocar auth)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: STAFF_TARGET, error: null });
    const res = await invocar(evento({ usuario_id: 's-1' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('un admin SÍ puede resetear la clave del equipo (200 + audit)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: ADMIN_CALLER, error: null })
      .mockResolvedValueOnce({ data: STAFF_TARGET, error: null });
    const res = await invocar(evento({ usuario_id: 's-1' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith('auth-s1', expect.objectContaining({ password: expect.any(String) }));
    expect((mockAuditInsert.mock.calls[0][0] as Record<string, unknown>).accion).toBe('password_reset');
  });

  it('ficha sin auth_id → 400 (no hay login que resetear)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: { ...TARGET, auth_id: null }, error: null });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('tras resetear deja el aviso cambiar_password al dueño de la cuenta (gate)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(200);
    expect(mockNotifInsert).toHaveBeenCalledWith(expect.objectContaining({
      usuario_id: 'm-1', tenant_id: 't1', tipo: 'cambiar_password'
    }));
  });
});
