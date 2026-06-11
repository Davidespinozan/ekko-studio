import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque D — `reception-corregir-checkin`: deshace un check-in del mismo día
 * (status → confirmada, limpia columnas) con motivo obligatorio + audit_log;
 * rechaza sin check-in, check-in viejo, y cross-tenant.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockAuditInsert = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
        update: mockUpdate
      };
    })
  }))
}));

import { handler } from '../../netlify/functions/reception-corregir-checkin/index';

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
const HOY_ISO = new Date().toISOString();
const RESERVA = {
  id: 'r1',
  tenant_id: 't1',
  usuario_id: 'm1',
  status: 'completada',
  check_in_at: HOY_ISO,
  check_in_method: 'manual',
  folio: 'EKK-000001'
};

function seq(...vals: unknown[]) {
  vals.forEach((v) => mockMaybeSingle.mockResolvedValueOnce({ data: v, error: null }));
}

describe('reception-corregir-checkin (Bloque D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset(); // limpia la cola de mockResolvedValueOnce entre tests
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  });

  it('check-in del día + motivo → deshace y audita', async () => {
    seq(CALLER, RESERVA);
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Check-in al miembro equivocado' }));
    expect(res.statusCode).toBe(200);

    const patch = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('confirmada');
    expect(patch.check_in_at).toBeNull();
    expect(patch.check_in_by).toBeNull();
    expect(patch.check_in_method).toBeNull();

    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('checkin_correction');
    expect(audit.target_tipo).toBe('usuario');
    expect(audit.target_id).toBe('m1');
  });

  it('sin motivo → 400', async () => {
    seq(CALLER, RESERVA);
    const res = await invocar(evento({ reserva_id: 'r1' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('reserva sin check-in → 400', async () => {
    seq(CALLER, { ...RESERVA, status: 'confirmada', check_in_at: null });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Error operativo de recepción' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('check-in de otro día → 400 (escalá a admin)', async () => {
    seq(CALLER, { ...RESERVA, check_in_at: '2020-01-01T10:00:00.000Z' });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Error operativo de recepción' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('cross-tenant → 403', async () => {
    seq(CALLER, { ...RESERVA, tenant_id: 'otro' });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Error operativo de recepción' }));
    expect(res.statusCode).toBe(403);
  });
});
