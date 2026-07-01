import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * reception-observar-reserva: guarda la observación de sesión (expediente).
 * Solo admin/recepcionista, mismo tenant, y audita el cambio.
 */

const mockGetUser = vi.fn();
const mockCallerMaybe = vi.fn();
const mockReservaMaybe = vi.fn();
const mockUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockAuditInsert = vi.fn().mockResolvedValue({ error: null });

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockCallerMaybe })) })) };
      }
      if (table === 'reservas') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockReservaMaybe })) })),
          update: vi.fn(() => ({ eq: mockUpdateEq }))
        };
      }
      return { insert: mockAuditInsert };
    })
  }))
}));

import { handler } from '../../netlify/functions/reception-observar-reserva/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (body: unknown): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent);
const invocar = async (body: unknown) =>
  (await handler(evento(body), {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateEq.mockResolvedValue({ error: null });
  mockAuditInsert.mockResolvedValue({ error: null });
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
});

describe('reception-observar-reserva', () => {
  it('no-staff → 403', async () => {
    mockCallerMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'miembro' }, error: null });
    const res = await invocar({ reserva_id: 'r1', observaciones: 'x' });
    expect(res.statusCode).toBe(403);
  });

  it('reserva de otro tenant → 403', async () => {
    mockCallerMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'recepcionista' }, error: null });
    mockReservaMaybe.mockResolvedValue({ data: { id: 'r1', tenant_id: 't2', usuario_id: 'm1', observaciones: null }, error: null });
    const res = await invocar({ reserva_id: 'r1', observaciones: 'x' });
    expect(res.statusCode).toBe(403);
    expect(mockUpdateEq).not.toHaveBeenCalled();
  });

  it('staff mismo tenant → guarda y audita', async () => {
    mockCallerMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'recepcionista' }, error: null });
    mockReservaMaybe.mockResolvedValue({ data: { id: 'r1', tenant_id: 't1', usuario_id: 'm1', observaciones: null }, error: null });
    const res = await invocar({ reserva_id: 'r1', observaciones: '  Mal uso de equipo  ' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).observaciones).toBe('Mal uso de equipo');
    expect(mockUpdateEq).toHaveBeenCalled();
    expect(mockAuditInsert).toHaveBeenCalled();
  });

  it('sin reserva_id → 400', async () => {
    const res = await invocar({ observaciones: 'x' });
    expect(res.statusCode).toBe(400);
  });
});
