import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Orquestación de reprogramar (Sprint RP-3b). Lo crítico: el ORDEN seguro
 * (crear→cancelar vs cancelar→crear según si el nuevo horario choca) y que
 * NINGÚN fallo parcial quede en silencio.
 *
 * Mock estable de supabase (vi.hoisted) — referencia fija, como el cliente
 * real (lección del bucle infinito de RP-3a).
 */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a) }
}));

import { reprogramarReserva, debeCancelarPrimero } from '../reprogramarReserva';

function params(overrides: Record<string, unknown> = {}) {
  return {
    reservaOriginalId: 'res-vieja',
    usuarioId: 'm-1',
    original: {
      recursoId: 'rec-1',
      inicio: new Date('2026-07-01T10:00:00.000Z'),
      fin: new Date('2026-07-01T11:00:00.000Z')
    },
    nuevo: {
      recursoId: 'rec-1',
      // Otro día → NO choca con la vieja.
      slotInicio: new Date('2026-07-03T15:00:00.000Z'),
      duracionMin: 60,
      notas: null
    },
    ...overrides
  };
}

// Nuevo horario contiguo a la vieja (vieja 10-11 → nuevo 11-12) → choca.
const nuevoContiguo = {
  recursoId: 'rec-1',
  slotInicio: new Date('2026-07-01T11:00:00.000Z'),
  duracionMin: 60,
  notas: null
};

beforeEach(() => {
  h.rpc.mockReset();
});

describe('debeCancelarPrimero', () => {
  const original = { recursoId: 'rec-1', inicio: 1000, fin: 2000 };

  it('horario lejano → false (crear primero es seguro)', () => {
    expect(debeCancelarPrimero(original, { recursoId: 'rec-1', inicio: 5000, fin: 6000 })).toBe(false);
  });

  it('horario contiguo → true (cualquier recurso: EKKO_CONTINUA)', () => {
    expect(debeCancelarPrimero(original, { recursoId: 'rec-2', inicio: 2000, fin: 3000 })).toBe(true);
    expect(debeCancelarPrimero(original, { recursoId: 'rec-1', inicio: 0, fin: 1000 })).toBe(true);
  });

  it('solape en el MISMO recurso → true (EKKO_SLOT_OCUPADO)', () => {
    expect(debeCancelarPrimero(original, { recursoId: 'rec-1', inicio: 1500, fin: 2500 })).toBe(true);
  });

  it('solape en DISTINTO recurso → false (el RPC solo valida solape por recurso)', () => {
    expect(debeCancelarPrimero(original, { recursoId: 'rec-2', inicio: 1500, fin: 2500 })).toBe(false);
  });
});

describe('reprogramarReserva · no choca (crear → cancelar)', () => {
  it('éxito: crea la nueva y después cancela la vieja', async () => {
    h.rpc.mockResolvedValue({ error: null });

    const r = await reprogramarReserva(params());

    expect(r.estado).toBe('ok');
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[0][0]).toBe('reservar_para_miembro_atomic');
    expect(h.rpc.mock.calls[1][0]).toBe('cancelar_reserva_atomic');
    expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_reserva_id: 'res-vieja' });
  });

  it('falla crear → NO toca la vieja, error_crear', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'reservar_para_miembro_atomic'
          ? { error: { message: 'EKKO_SLOT_OCUPADO: tomado' } }
          : { error: null }
      )
    );

    const r = await reprogramarReserva(params());

    expect(r.estado).toBe('error_crear');
    expect(r.mensaje).toMatch(/original sigue en pie/i);
    // cancelar_reserva_atomic NUNCA se llamó.
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0][0]).toBe('reservar_para_miembro_atomic');
  });

  it('crear OK pero cancelar falla → parcial_sin_cancelar (avisa: cancelar manual)', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'cancelar_reserva_atomic'
          ? { error: { message: 'EKKO_RESERVA_NO_EXISTE' } }
          : { error: null }
      )
    );

    const r = await reprogramarReserva(params());

    expect(r.estado).toBe('parcial_sin_cancelar');
    expect(r.mensaje).toMatch(/cancelá la reserva original manualmente/i);
  });
});

describe('reprogramarReserva · choca (cancelar → crear)', () => {
  it('éxito: cancela la vieja primero y después crea la nueva', async () => {
    h.rpc.mockResolvedValue({ error: null });

    const r = await reprogramarReserva(params({ nuevo: nuevoContiguo }));

    expect(r.estado).toBe('ok');
    expect(h.rpc.mock.calls[0][0]).toBe('cancelar_reserva_atomic');
    expect(h.rpc.mock.calls[1][0]).toBe('reservar_para_miembro_atomic');
  });

  it('cancelar OK pero crear falla → parcial_sin_recrear (avisa: miembro sin reserva)', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'reservar_para_miembro_atomic'
          ? { error: { message: 'EKKO_SLOT_OCUPADO: tomado' } }
          : { error: null }
      )
    );

    const r = await reprogramarReserva(params({ nuevo: nuevoContiguo }));

    expect(r.estado).toBe('parcial_sin_recrear');
    expect(r.mensaje).toMatch(/sin reserva/i);
  });

  it('falla cancelar → NO intenta crear, error_cancelar', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'cancelar_reserva_atomic'
          ? { error: { message: 'EKKO_RESERVA_NO_CANCELABLE' } }
          : { error: null }
      )
    );

    const r = await reprogramarReserva(params({ nuevo: nuevoContiguo }));

    expect(r.estado).toBe('error_cancelar');
    expect(r.mensaje).toMatch(/original sigue en pie/i);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0][0]).toBe('cancelar_reserva_atomic');
  });
});
