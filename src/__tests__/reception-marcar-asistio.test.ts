import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `reception-marcar-asistio`: corrige la asistencia de un no_show/cancelada ya
 * iniciada → completada con check-in manual; si era no_show revierte la falta y
 * levanta el bloqueo si se debía a ella. Motivo obligatorio + audit_log.
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

import { handler } from '../../netlify/functions/reception-marcar-asistio/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(body: unknown): AnyEvent {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
}
async function invocar(event: AnyEvent) {
  const res = await handler(event, {} as never, () => {});
  return res as { statusCode: number; body: string };
}

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista' };
const PASADO = '2020-01-01T10:00:00.000Z';
const FUTURO = '2999-01-01T10:00:00.000Z';
const DIA = 24 * 60 * 60 * 1000;
const RESERVA_NO_SHOW = { id: 'r1', tenant_id: 't1', usuario_id: 'm1', status: 'no_show', slot_inicio: PASADO, folio: 'EKK-000001' };

function seq(...vals: unknown[]) {
  vals.forEach((v) => mockMaybeSingle.mockResolvedValueOnce({ data: v, error: null }));
}
function updates(): Record<string, unknown>[] {
  return mockUpdate.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

describe('reception-marcar-asistio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  });

  it('no_show pasado → completada con check-in manual, revierte la falta y levanta el bloqueo que causó', async () => {
    // 3 faltas (umbral 3) con bloqueo vigente → al revertir queda en 2 → se levanta.
    seq(CALLER, RESERVA_NO_SHOW, { id: 'm1', no_shows_count: 3, bloqueado_hasta: new Date(Date.now() + 5 * DIA).toISOString() }, { config: {} });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Sí vino, no le hicieron check-in' }));
    expect(res.statusCode).toBe(200);
    const [upReserva, upMiembro] = updates();
    expect(upReserva).toMatchObject({ status: 'completada', check_in_by: 'u-recep', check_in_method: 'manual' });
    expect(upReserva.check_in_at).toBeTruthy();
    expect(upMiembro).toEqual({ no_shows_count: 2, bloqueado_hasta: null });
    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('asistencia_correction');
    expect(audit.target_id).toBe('m1');
    expect(audit.motivo).toBe('Sí vino, no le hicieron check-in');
  });

  it('no_show con bloqueo que NO se debe a esta falta (sigue sobre el umbral) → conserva el bloqueo', async () => {
    const hasta = new Date(Date.now() + 5 * DIA).toISOString();
    seq(CALLER, RESERVA_NO_SHOW, { id: 'm1', no_shows_count: 5, bloqueado_hasta: hasta }, { config: {} });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Sí vino' }));
    expect(res.statusCode).toBe(200);
    expect(updates()[1]).toEqual({ no_shows_count: 4, bloqueado_hasta: hasta });
  });

  it('cancelada pasada → completada sin tocar penalización', async () => {
    seq(CALLER, { ...RESERVA_NO_SHOW, status: 'cancelada_admin' });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Vino igual' }));
    expect(res.statusCode).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ status: 'completada' });
  });

  it('sesión futura → 400; confirmada → 400; completada → 400', async () => {
    seq(CALLER, { ...RESERVA_NO_SHOW, slot_inicio: FUTURO });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(400);
    seq(CALLER, { ...RESERVA_NO_SHOW, status: 'confirmada' });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(400);
    seq(CALLER, { ...RESERVA_NO_SHOW, status: 'completada' });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sin motivo → 400 (antes de tocar la DB); cross-tenant → 403; miembro → 403', async () => {
    expect((await invocar(evento({ reserva_id: 'r1' }))).statusCode).toBe(400);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    seq(CALLER, { ...RESERVA_NO_SHOW, tenant_id: 'otro' });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(403);
    seq({ ...CALLER, rol: 'miembro' });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
