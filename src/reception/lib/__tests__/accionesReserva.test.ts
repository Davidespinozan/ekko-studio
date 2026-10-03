import { describe, it, expect } from 'vitest';
import { esCorregibleAsistencia, MOTIVOS_ASISTIO } from '../accionesReserva';

/** R2-A (PKG-01I): "sí asistió" solo para un no_show ya iniciado. */
describe('esCorregibleAsistencia', () => {
  const ahora = new Date('2026-10-03T18:00:00.000Z');
  const pasado = '2026-10-03T16:00:00.000Z';
  const futuro = '2026-10-03T20:00:00.000Z';

  it('no_show ya iniciado → sí', () => {
    expect(esCorregibleAsistencia({ status: 'no_show', slot_inicio: pasado }, ahora)).toBe(true);
  });

  it('no_show futuro → no', () => {
    expect(esCorregibleAsistencia({ status: 'no_show', slot_inicio: futuro }, ahora)).toBe(false);
  });

  it('cancelada / cancelada_admin / confirmada / completada → no (una cancelada no se revive)', () => {
    for (const status of ['cancelada', 'cancelada_admin', 'confirmada', 'completada']) {
      expect(esCorregibleAsistencia({ status, slot_inicio: pasado }, ahora), status).toBe(false);
    }
  });

  it('los motivos ya no ofrecen "cancelación por error"', () => {
    expect(MOTIVOS_ASISTIO.some((m) => /cancela/i.test(m))).toBe(false);
  });
});
