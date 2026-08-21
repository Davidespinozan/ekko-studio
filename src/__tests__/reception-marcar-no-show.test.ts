import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque D — `reception-marcar-no-show`: aplica el efecto del cron sobre una
 * reserva puntual con motivo obligatorio + audit_log; rechaza estados/tenant
 * inválidos.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockAuditInsert = vi.fn();
const mockNotifInsert = vi.fn();
const mockPush = vi.fn();

vi.mock('../../netlify/functions/_lib/push', () => ({
  enviarPushAUsuario: (...args: unknown[]) => mockPush(...args)
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
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

import { handler } from '../../netlify/functions/reception-marcar-no-show/index';

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
const PASADO = '2020-01-01T10:00:00.000Z';
const FUTURO = '2999-01-01T10:00:00.000Z';
const RESERVA = {
  id: 'r1',
  tenant_id: 't1',
  usuario_id: 'm1',
  status: 'confirmada',
  check_in_at: null,
  slot_fin: PASADO,
  folio: 'EKK-000001'
};
// no_shows_count: 2 → esta falta es la 3ª, que alcanza el umbral y bloquea.
const MIEMBRO = { id: 'm1', no_shows_count: 2, bloqueado_hasta: null };
// Config del tenant (Admin → Reglas → Penalizaciones). Sin config → 7 días / 3 faltas.
const TENANT_DEFAULT = { config: {} };
const DIA = 24 * 60 * 60 * 1000;

function seq(...vals: unknown[]) {
  vals.forEach((v) => mockMaybeSingle.mockResolvedValueOnce({ data: v, error: null }));
}

describe('reception-marcar-no-show (Bloque D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset(); // limpia la cola de mockResolvedValueOnce entre tests
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockNotifInsert.mockResolvedValue({ error: null });
    mockPush.mockResolvedValue(true);
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  });

  it('3ª falta → marca no_show, penaliza (bloquea) y audita', async () => {
    seq(CALLER, RESERVA, MIEMBRO, TENANT_DEFAULT);
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(200);

    // 1ª update = reserva → no_show; 2ª = usuario → contador+bloqueo.
    expect((mockUpdate.mock.calls[0][0] as Record<string, unknown>).status).toBe('no_show');
    const upUser = mockUpdate.mock.calls[1][0] as Record<string, unknown>;
    expect(upUser.no_shows_count).toBe(3); // 2 + 1 → alcanza el umbral
    expect(upUser.bloqueado_hasta).toBeTruthy();

    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('no_show_manual');
    expect(audit.target_tipo).toBe('usuario');
    expect(audit.target_id).toBe('m1');
    expect(audit.motivo).toBe('Cliente no se presentó');
    expect((audit.metadata as Record<string, unknown>).reserva_id).toBe('r1');

    // Aviso al miembro (in-app + push) con el bloqueo.
    const notif = mockNotifInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(notif.usuario_id).toBe('m1');
    expect(notif.tipo).toBe('no_show');
    expect(notif.titulo).toMatch(/bloqueada/i);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('lee los días de bloqueo de la config del tenant (15), no 7 fijos', async () => {
    seq(CALLER, RESERVA, MIEMBRO, { config: { penalizaciones: { no_show_bloqueo_dias: 15 } } });
    const antes = Date.now();
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(200);
    const upUser = mockUpdate.mock.calls[1][0] as Record<string, unknown>;
    const hasta = new Date(upUser.bloqueado_hasta as string).getTime();
    expect(hasta - antes).toBeGreaterThan(14.9 * DIA);
    expect(hasta - antes).toBeLessThan(15.1 * DIA);
  });

  it('0 días configurados → registra la falta y avisa, pero NO bloquea', async () => {
    seq(CALLER, RESERVA, MIEMBRO, { config: { penalizaciones: { no_show_bloqueo_dias: 0 } } });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(200);
    const upUser = mockUpdate.mock.calls[1][0] as Record<string, unknown>;
    expect(upUser.no_shows_count).toBe(3);
    expect(upUser.bloqueado_hasta).toBeNull();
    const notif = mockNotifInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(notif.titulo).toMatch(/inasistencia/i);
    expect(notif.mensaje).not.toMatch(/bloquea/);
  });

  it('umbral configurable: con no_show_umbral=1 bloquea a la primera falta', async () => {
    seq(CALLER, RESERVA, { id: 'm1', no_shows_count: 0, bloqueado_hasta: null }, { config: { penalizaciones: { no_show_umbral: 1 } } });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(200);
    const upUser = mockUpdate.mock.calls[1][0] as Record<string, unknown>;
    expect(upUser.bloqueado_hasta).toBeTruthy();
  });

  it('1ª/2ª falta → marca no_show y cuenta, pero NO bloquea (bajo umbral)', async () => {
    seq(CALLER, RESERVA, { id: 'm1', no_shows_count: 0, bloqueado_hasta: null }, TENANT_DEFAULT);
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(200);
    const upUser = mockUpdate.mock.calls[1][0] as Record<string, unknown>;
    expect(upUser.no_shows_count).toBe(1); // 0 + 1
    expect(upUser.bloqueado_hasta).toBeFalsy(); // aún no llega a 3 → sin bloqueo
  });

  it('sin motivo → 400, sin update ni audit', async () => {
    seq(CALLER, RESERVA, MIEMBRO, TENANT_DEFAULT);
    const res = await invocar(evento({ reserva_id: 'r1' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('reserva ya cancelada → 400', async () => {
    seq(CALLER, { ...RESERVA, status: 'cancelada' });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('reserva con check-in → 400', async () => {
    seq(CALLER, { ...RESERVA, status: 'completada', check_in_at: PASADO });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(400);
  });

  it('slot todavía no terminó → 400', async () => {
    seq(CALLER, { ...RESERVA, slot_fin: FUTURO });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(400);
  });

  it('cross-tenant → 403', async () => {
    seq(CALLER, { ...RESERVA, tenant_id: 'otro' });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('un miembro no puede → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Cliente no se presentó' }));
    expect(res.statusCode).toBe(403);
  });
});
