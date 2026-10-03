import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `reception-corregir-checkin` (R2-A · PKG-01I): deshacer un check-in del mismo
 * día es la RPC `staff_corregir_asistencia` (accion 'deshacer_checkin'): reserva
 * bloqueada, solo desde `completada`, auditoría en la misma transacción. La
 * función solo autentica y traduce errores.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockRpc = vi.fn();
const mockFromWrite = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
      update: mockFromWrite,
      insert: mockFromWrite
    }))
  }))
}));

import { handler } from '../../netlify/functions/reception-corregir-checkin/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (body: unknown) =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) }) as unknown as AnyEvent;
const invocar = async (event: AnyEvent) => (await handler(event, {} as never, () => {})) as { statusCode: number; body: string };

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };

describe('reception-corregir-checkin (R2-A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: CALLER, error: null });
    mockRpc.mockResolvedValue({ data: { success: true, status: 'confirmada' }, error: null });
  });

  it('check-in del día + motivo → RPC deshacer_checkin; sin escrituras directas', async () => {
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Check-in al miembro equivocado' }));
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('staff_corregir_asistencia', {
      p_actor_id: 'u-recep', p_reserva_id: 'r1', p_accion: 'deshacer_checkin', p_motivo: 'Check-in al miembro equivocado'
    });
    expect(JSON.parse(res.body)).toMatchObject({ success: true, status: 'confirmada' });
    expect(mockFromWrite).not.toHaveBeenCalled();
  });

  it('sin motivo → 400 sin llamar la RPC', async () => {
    expect((await invocar(evento({ reserva_id: 'r1' }))).statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sin check-in / no_show / cancelada → 409; check-in de otro día → 400; otro estudio → 403', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_TRANSICION_INVALIDA: La reserva no tiene check-in que corregir (estado: confirmada)' } });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'Error operativo' }))).statusCode).toBe(409);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_FUERA_DE_PLAZO: x' } });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'Error operativo' }))).statusCode).toBe(400);
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_OTRO_ESTUDIO: x' } });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'Error operativo' }))).statusCode).toBe(403);
  });
});
