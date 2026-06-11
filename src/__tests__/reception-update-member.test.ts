import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque A — gobernanza. Tests de la Netlify Function `reception-update-member`:
 *  - motivo OBLIGATORIO en status/tier/desbloqueo (400 si falta).
 *  - escribe audit_log por acción con antes/después correctos.
 *  - contacto NO requiere motivo.
 *  - dejó de escribir en notas_admin (B1/B2).
 *  - desbloqueo NO resetea no_shows_count (B4).
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockAuditInsert = vi.fn();
const mockUpdateUserById = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { updateUserById: mockUpdateUserById }
    },
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      // usuarios: soporta select().eq().maybeSingle() y update().eq()
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
        update: mockUpdate
      };
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://cdn.test/a.jpg' } }))
      }))
    }
  }))
}));

import { handler } from '../../netlify/functions/reception-update-member/index';

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

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', nombre: 'Recep' };
const TARGET = {
  id: 'm-1',
  auth_id: 'auth-m1',
  tenant_id: 't1',
  nombre: 'Ana',
  email: 'ana@cravia.mx',
  telefono: '123',
  status: 'activo',
  membresia_tier: 'basica',
  bloqueado_hasta: null,
  no_shows_count: 0
};

function setCallerTarget(target: Record<string, unknown> = TARGET) {
  mockMaybeSingle
    .mockResolvedValueOnce({ data: CALLER, error: null })
    .mockResolvedValueOnce({ data: target, error: null });
}

function patchEnviado(): Record<string, unknown> {
  return mockUpdate.mock.calls[0][0] as Record<string, unknown>;
}

function auditDe(accion: string): Record<string, unknown> | undefined {
  return mockAuditInsert.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => e.accion === accion);
}

describe('reception-update-member · gobernanza (Bloque A)', () => {
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

  it('cambio de status SIN motivo → 400, sin update ni audit', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'suspendido' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('cambio de status CON motivo → 200 + audit status_change con antes/después', async () => {
    setCallerTarget();
    const res = await invocar(
      evento({ usuario_id: 'm-1', status: 'suspendido', motivo: 'Cliente solicitó suspensión' })
    );
    expect(res.statusCode).toBe(200);
    const patch = patchEnviado();
    expect(patch.status).toBe('suspendido');
    // B1/B2: ya no se escribe notas_admin.
    expect(patch).not.toHaveProperty('notas_admin');
    const audit = auditDe('status_change');
    expect(audit).toBeDefined();
    expect(audit?.antes).toEqual({ status: 'activo' });
    expect(audit?.despues).toEqual({ status: 'suspendido' });
    expect(audit?.motivo).toBe('Cliente solicitó suspensión');
    expect(audit?.actor_usuario_id).toBe('u-recep');
  });

  it('cambio de tier SIN motivo → 400', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', membresia_tier: 'pro' }));
    expect(res.statusCode).toBe(400);
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('edición de contacto NO requiere motivo → 200 + audit contact_change', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'Ana María' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    const patch = patchEnviado();
    expect(patch.nombre).toBe('Ana María');
    expect(patch).not.toHaveProperty('notas_admin');
    expect(auditDe('contact_change')).toBeDefined();
  });

  it('desbloqueo CON motivo: bloqueado_hasta=null y NO resetea no_shows_count (B4)', async () => {
    setCallerTarget({ ...TARGET, bloqueado_hasta: '2099-01-01T00:00:00Z', no_shows_count: 3 });
    const res = await invocar(
      evento({ usuario_id: 'm-1', unblock: true, motivo: 'Error operativo (no fue no-show real)' })
    );
    expect(res.statusCode).toBe(200);
    const patch = patchEnviado();
    expect(patch.bloqueado_hasta).toBeNull();
    expect(patch).not.toHaveProperty('no_shows_count'); // B4: no se toca
    const audit = auditDe('unblock');
    expect(audit).toBeDefined();
    expect((audit?.despues as Record<string, unknown>).no_shows_count).toBe(3); // conservado
  });

  it('desbloqueo SIN motivo → 400', async () => {
    setCallerTarget({ ...TARGET, bloqueado_hasta: '2099-01-01T00:00:00Z', no_shows_count: 3 });
    const res = await invocar(evento({ usuario_id: 'm-1', unblock: true }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('un miembro NO puede usar la función (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...CALLER, rol: 'miembro' },
      error: null
    });
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'X' }));
    expect(res.statusCode).toBe(403);
  });
});
