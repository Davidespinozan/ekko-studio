import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/**
 * Bloque E — `reception-notificar-miembro`: inserta en notificaciones +
 * audit_log; rechaza mensaje vacío y cross-tenant.
 *
 * Entorno hermético (PKG-00C): el escenario es "push NO configurado" (sin
 * VAPID, el envío es un no-op). Si el runner inyecta claves VAPID, el handler
 * intenta enviar push contra el mock de supabase y responde 500. La suite
 * borra esas variables explícitamente y restaura el entorno original.
 */

const ENV_SUITE = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;
const envOriginal: Partial<Record<(typeof ENV_SUITE)[number], string | undefined>> = {};
beforeAll(() => { for (const k of ENV_SUITE) envOriginal[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_SUITE) {
    if (envOriginal[k] === undefined) delete process.env[k];
    else process.env[k] = envOriginal[k];
  }
});

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockNotifInsert = vi.fn();
const mockAuditInsert = vi.fn();
const mockRpc = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: vi.fn((table: string) => {
      // PKG-03A: el insert devuelve el id para asentar el resultado del push después.
      if (table === 'notificaciones') {
        return { insert: (fila: unknown) => { mockNotifInsert(fila); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'n-1' }, error: null }) }) }; } };
      }
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

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
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
    delete process.env.VAPID_PUBLIC_KEY; // push no configurado → no-op
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: 1, error: null });
  });

  it('válido → inserta notificación (aviso_manual) + audit; el push se asienta después, con resultado honesto', async () => {
    seq(CALLER, TARGET);
    const res = await invocar(evento({ miembro_id: 'm1', mensaje: 'Tu pago vence mañana' }));
    expect(res.statusCode).toBe(200);
    // Sin VAPID: no salió nada al teléfono y la respuesta no lo afirma.
    expect(JSON.parse(res.body)).toEqual({ success: true, push: 'sin_config' });

    const notif = mockNotifInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(notif.tipo).toBe('aviso_manual');
    expect(notif.usuario_id).toBe('m1');
    expect(notif.mensaje).toBe('Tu pago vence mañana');
    // PKG-03A: ya no se marca "enviado" al insertar; se reclama con un lease.
    expect(notif).not.toHaveProperty('push_enviado_at');
    expect(typeof notif.push_intento_at).toBe('string');
    expect(mockRpc).toHaveBeenCalledWith('registrar_resultado_push', { p_ids: ['n-1'], p_resultado: 'sin_config' });

    // PKG-03A (F-9): "registrado", no "enviado".
    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('aviso_registrado');
    expect(audit.target_id).toBe('m1');
    expect(audit.despues).toEqual({ mensaje: 'Tu pago vence mañana', push: 'sin_config' });
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
