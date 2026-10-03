import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `reception-marcar-asistio` (R2-A · PKG-01I): autentica al staff y delega TODA
 * la corrección en la RPC `staff_corregir_asistencia` (accion 'asistio'). Ya no
 * escribe reservas / usuarios / audit_log desde Netlify. Los errores EKKO_* de
 * la RPC se traducen a HTTP. La transición y la penalización se prueban contra
 * Postgres real en src/__tests__/db/r2a-reservas.db.test.ts.
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

import { handler } from '../../netlify/functions/reception-marcar-asistio/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (body: unknown) =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) }) as unknown as AnyEvent;
const invocar = async (event: AnyEvent) => (await handler(event, {} as never, () => {})) as { statusCode: number; body: string };

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };

describe('reception-marcar-asistio (R2-A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: CALLER, error: null });
    mockRpc.mockResolvedValue({ data: { success: true, status: 'completada', penalizacion: { no_shows_count: 2, bloqueado_hasta: null } }, error: null });
  });

  it('delega en staff_corregir_asistencia(asistio) con actor, reserva y motivo; sin escrituras directas', async () => {
    const res = await invocar(evento({ reserva_id: 'r1', motivo: '  Sí vino, no le hicieron check-in ' }));
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('staff_corregir_asistencia', {
      p_actor_id: 'u-recep', p_reserva_id: 'r1', p_accion: 'asistio', p_motivo: 'Sí vino, no le hicieron check-in'
    });
    expect(JSON.parse(res.body)).toMatchObject({ success: true, status: 'completada', penalizacion: { no_shows_count: 2 } });
    expect(mockFromWrite).not.toHaveBeenCalled();
  });

  it('cancelada → 409 transicion_invalida (ya no se revive una cancelada)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_TRANSICION_INVALIDA: Una reserva cancelada no se revive; crea una reserva nueva' } });
    const res = await invocar(evento({ reserva_id: 'r1', motivo: 'Vino igual' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ code: 'transicion_invalida', error: 'Una reserva cancelada no se revive; crea una reserva nueva' });
  });

  it('errores de la RPC: futura/completada → 400; otro estudio → 403; no existe → 404; revocada → 403; identidad → 400', async () => {
    const casos: Array<[string, number]> = [
      ['EKKO_SESION_NO_INICIA: x', 400],
      ['EKKO_YA_COMPLETADA: x', 400],
      ['EKKO_OTRO_ESTUDIO: x', 403],
      ['EKKO_RESERVA_NO_EXISTE: x', 404],
      ['EKKO_CUENTA_REVOCADA: El acceso de esta cuenta fue revocado', 403],
      ['EKKO_IDENTIDAD_INCOMPLETA: Falta la foto', 400],
      ['boom', 500]
    ];
    for (const [message, status] of casos) {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message } });
      expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode, message).toBe(status);
    }
  });

  it('sin motivo → 400 antes de tocar nada; miembro → 403 sin llamar la RPC', async () => {
    expect((await invocar(evento({ reserva_id: 'r1' }))).statusCode).toBe(400);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, status: 'revocado' }, error: null });
    expect((await invocar(evento({ reserva_id: 'r1', motivo: 'xxx' }))).statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
