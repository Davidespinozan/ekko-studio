import { describe, it, expect } from 'vitest';
import { desdeReservasVigentesISO, sesionEnCurso, GRACIA_CHECKIN_MIN } from '../reservasVigentes';

const AHORA = new Date('2026-09-20T18:00:00.000Z');
const min = (n: number) => new Date(AHORA.getTime() + n * 60_000).toISOString();

/** Reproduce el filtro de las consultas: `.gte('slot_fin', desde)`. */
const sigueVisible = (slotFin: string) => slotFin >= desdeReservasVigentesISO(AHORA);

describe('reservas vigentes para el miembro', () => {
  it('una sesión que EMPEZÓ hace 1 minuto sigue visible (antes desaparecía con su QR)', () => {
    expect(sigueVisible(min(59))).toBe(true); // empezó hace 1 min, termina en 59
    expect(sesionEnCurso(min(-1), AHORA)).toBe(true);
  });

  it('sigue visible mientras el check-in está abierto: hasta 30 min después de terminar', () => {
    expect(GRACIA_CHECKIN_MIN).toBe(30);
    expect(sigueVisible(min(-29))).toBe(true);
    expect(sigueVisible(min(-31))).toBe(false);
  });

  it('una sesión futura no está "en curso"', () => {
    expect(sesionEnCurso(min(120), AHORA)).toBe(false);
  });
});
