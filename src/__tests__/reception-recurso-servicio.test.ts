import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque F — `reception-recurso-servicio`: marca/reactiva un estudio,
 * auto-cancela las reservas futuras al marcarlo fuera de servicio, notifica,
 * y escribe audit_log. Rechaza body inválido y cross-tenant.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockRecursoUpdate = vi.fn();
const mockReservasGt = vi.fn();
const mockReservasIn = vi.fn();
const mockReservasUpdate = vi.fn();
const mockNotifInsert = vi.fn();
const mockAuditInsert = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      if (table === 'notificaciones') return { insert: mockNotifInsert };
      if (table === 'recursos') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
          update: mockRecursoUpdate
        };
      }
      if (table === 'reservas') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ gt: mockReservasGt })) })) })),
          update: mockReservasUpdate
        };
      }
      // usuarios (caller)
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) };
    })
  }))
}));

import { handler } from '../../netlify/functions/reception-recurso-servicio/index';

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
const RECURSO = { id: 'rec1', tenant_id: 't1', nombre: 'Estudio A', fuera_de_servicio: false };

describe('reception-recurso-servicio (Bloque F)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockRecursoUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    mockReservasUpdate.mockReturnValue({ in: mockReservasIn });
    mockReservasIn.mockResolvedValue({ error: null });
    mockNotifInsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('marcar fuera de servicio: cancela futuras, notifica y audita', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: RECURSO, error: null });
    mockReservasGt.mockResolvedValue({
      data: [
        { id: 'r1', usuario_id: 'm1', slot_inicio: '2999-01-01T10:00:00Z', folio: 'EKK-1' },
        { id: 'r2', usuario_id: 'm2', slot_inicio: '2999-01-02T10:00:00Z', folio: 'EKK-2' }
      ],
      error: null
    });

    const res = await invocar(evento({ recurso_id: 'rec1', fuera_de_servicio: true, motivo: 'mantenimiento' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reservas_canceladas).toBe(2);

    expect((mockRecursoUpdate.mock.calls[0][0] as Record<string, unknown>).fuera_de_servicio).toBe(true);
    expect((mockReservasUpdate.mock.calls[0][0] as Record<string, unknown>).status).toBe('cancelada_admin');
    expect(mockReservasIn).toHaveBeenCalledWith('id', ['r1', 'r2']);
    expect((mockNotifInsert.mock.calls[0][0] as unknown[]).length).toBe(2);

    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('recurso_fuera_servicio');
    expect(audit.target_tipo).toBe('recurso');
    expect((audit.metadata as Record<string, unknown>).reservas_canceladas).toBe(2);
  });

  it('reactivar: limpia el flag, sin cancelar nada', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: { ...RECURSO, fuera_de_servicio: true }, error: null });

    const res = await invocar(evento({ recurso_id: 'rec1', fuera_de_servicio: false }));
    expect(res.statusCode).toBe(200);
    expect((mockRecursoUpdate.mock.calls[0][0] as Record<string, unknown>).fuera_de_servicio).toBe(false);
    expect(mockReservasUpdate).not.toHaveBeenCalled();
    expect(mockNotifInsert).not.toHaveBeenCalled();
    expect((mockAuditInsert.mock.calls[0][0] as Record<string, unknown>).accion).toBe('recurso_reactivado');
  });

  it('fuera_de_servicio no booleano → 400', async () => {
    const res = await invocar(evento({ recurso_id: 'rec1' }));
    expect(res.statusCode).toBe(400);
  });

  it('cross-tenant → 403', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: { ...RECURSO, tenant_id: 'otro' }, error: null });
    const res = await invocar(evento({ recurso_id: 'rec1', fuera_de_servicio: true }));
    expect(res.statusCode).toBe(403);
    expect(mockRecursoUpdate).not.toHaveBeenCalled();
  });

  it('un miembro no puede → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento({ recurso_id: 'rec1', fuera_de_servicio: true }));
    expect(res.statusCode).toBe(403);
  });
});
