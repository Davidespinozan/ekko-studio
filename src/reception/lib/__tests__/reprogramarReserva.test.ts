import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * R2-A (PKG-01J) · reprogramar = UNA RPC atómica (`reprogramar_reserva`).
 * Ya no hay orden crear→cancelar / cancelar→crear ni estados parciales: si el
 * servidor rechaza, NADA cambió. El comportamiento transaccional (rollback,
 * créditos, traslado de extras, fichas, aviso) se prueba contra Postgres real en
 * src/__tests__/db/r2a-reservas.db.test.ts.
 */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a) }
}));

import { reprogramarReserva } from '../reprogramarReserva';

const params = (invitados?: number) => ({
  reservaOriginalId: 'res-vieja',
  nuevo: {
    recursoId: 'rec-2',
    slotInicio: new Date('2026-07-03T15:00:00.000Z'),
    duracionMin: 90,
    notas: 'trae tripié',
    ...(invitados === undefined ? {} : { invitados })
  }
});

beforeEach(() => {
  h.rpc.mockReset();
});

describe('reprogramarReserva (R2-A)', () => {
  it('una sola llamada a reprogramar_reserva con todos los parámetros; ok con la reserva nueva', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, reserva_id: 'res-nueva', folio: 'EKK-000010' }, error: null });
    const r = await reprogramarReserva(params(2));
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith('reprogramar_reserva', {
      p_reserva_id: 'res-vieja',
      p_recurso_id: 'rec-2',
      p_slot_inicio: '2026-07-03T15:00:00.000Z',
      p_duracion_min: 90,
      p_invitados: 2,
      p_notas: 'trae tripié'
    });
    expect(r).toEqual({ estado: 'ok', mensaje: 'Reserva reprogramada.', reservaId: 'res-nueva' });
  });

  it('sin invitados explícitos → null: el servidor conserva los de la original', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, reserva_id: 'x' }, error: null });
    await reprogramarReserva(params());
    expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_invitados: null });
  });

  it('error → estado error, traducido, y "la reserva original sigue en pie" (no hay parciales)', async () => {
    const casos: Array<[string, RegExp]> = [
      ['EKKO_SLOT_OCUPADO: Este horario ya está reservado', /sigue en pie/],
      ['EKKO_EXTRAS_EXCEDEN_TOPE: x', /invitados extra pagados/],
      ['EKKO_FICHAS_EXCEDEN: x', /invitados registrados/],
      ['EKKO_REPROGRAMAR_PASADA: x', /ya empezó/],
      ['EKKO_MISMO_HORARIO: x', /horario actual/]
    ];
    for (const [message, re] of casos) {
      h.rpc.mockResolvedValueOnce({ data: null, error: { message } });
      const r = await reprogramarReserva(params());
      expect(r.estado).toBe('error');
      expect(r.mensaje).toMatch(re);
      expect(r.mensaje).toMatch(/La reserva original sigue en pie\./);
    }
    expect(h.rpc).toHaveBeenCalledTimes(casos.length);
    expect(h.rpc.mock.calls.every((c) => c[0] === 'reprogramar_reserva')).toBe(true);
  });
});
