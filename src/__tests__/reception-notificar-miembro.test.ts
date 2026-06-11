import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque E — `reception-notificar-miembro`: inserta en notificaciones +
 * audit_log; rechaza mensaje vacío y cross-tenant.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockNotifInsert = vi.fn();
const mockAuditInsert = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'notificaciones') return { insert: mockNotifInsert };
      if (table === 'audit_log') return { insert: mockAuditInsert };
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) };
    })
  }))
}));

import { handler } from '../../netlify/functions/reception-notificar-miembro/index';

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
const TARGET = { id: 'm1', tenant_id: 't1' };

function seq(...vals: unknown[]) {
  vals.forEach((v) => mockMaybeSingle.mockResolvedValueOnce({ data: v, error: null }));
}

describe('reception-notificar-miembro (Bloque E)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockNotifInsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('válido → inserta notificación (aviso_manual) + audit', async () => {
    seq(CALLER, TARGET);
    const res = await invocar(evento({ miembro_id: 'm1', mensaje: 'Tu pago vence mañana' }));
    expect(res.statusCode).toBe(200);

    const notif = mockNotifInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(notif.tipo).toBe('aviso_manual');
    expect(notif.usuario_id).toBe('m1');
    expect(notif.mensaje).toBe('Tu pago vence mañana');

    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('notification_sent');
    expect(audit.target_id).toBe('m1');
  });

  it('mensaje vacío → 400', async () => {
    seq(CALLER, TARGET);
    const res = await invocar(evento({ miembro_id: 'm1', mensaje: '   ' }));
    expect(res.statusCode).toBe(400);
    expect(mockNotifInsert).not.toHaveBeenCalled();
  });

  it('cross-tenant → 403', async () => {
    seq(CALLER, { ...TARGET, tenant_id: 'otro' });
    const res = await invocar(evento({ miembro_id: 'm1', mensaje: 'Hola' }));
    expect(res.statusCode).toBe(403);
    expect(mockNotifInsert).not.toHaveBeenCalled();
  });

  it('un miembro no puede → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento({ miembro_id: 'm1', mensaje: 'Hola' }));
    expect(res.statusCode).toBe(403);
  });
});
