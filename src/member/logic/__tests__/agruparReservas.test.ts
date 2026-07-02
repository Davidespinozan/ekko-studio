import { describe, it, expect } from 'vitest';
import { agruparPorDia } from '../agruparReservas';

const AHORA = new Date('2026-07-07T12:00:00');

function r(slot: string) {
  return { slot_inicio: slot, id: slot };
}

describe('agruparPorDia', () => {
  it('agrupa varias reservas del mismo día en un solo grupo', () => {
    const grupos = agruparPorDia(
      [r('2026-07-07T15:00:00'), r('2026-07-07T18:00:00')],
      AHORA
    );
    expect(grupos).toHaveLength(1);
    expect(grupos[0].items).toHaveLength(2);
    expect(grupos[0].label).toBe('Hoy');
  });

  it('etiqueta Hoy / Mañana / Ayer', () => {
    const grupos = agruparPorDia(
      [r('2026-07-07T10:00:00'), r('2026-07-08T10:00:00'), r('2026-07-06T10:00:00')],
      AHORA
    );
    expect(grupos.map((g) => g.label)).toEqual(['Hoy', 'Mañana', 'Ayer']);
  });

  it('usa fecha larga para días fuera del rango cercano', () => {
    const grupos = agruparPorDia([r('2026-07-20T10:00:00')], AHORA);
    expect(grupos[0].label).toMatch(/julio/);
    // capitalizada
    expect(grupos[0].label[0]).toBe(grupos[0].label[0].toUpperCase());
  });

  it('preserva el orden de entrada de los grupos', () => {
    const grupos = agruparPorDia(
      [r('2026-07-09T10:00:00'), r('2026-07-07T10:00:00')],
      AHORA
    );
    expect(grupos[0].label).toMatch(/julio/); // 9 jul primero
    expect(grupos[1].label).toBe('Hoy');
  });

  it('ignora reservas con slot inválido', () => {
    const grupos = agruparPorDia([r('no-es-fecha'), r('2026-07-07T10:00:00')], AHORA);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].items).toHaveLength(1);
  });

  it('lista vacía → sin grupos', () => {
    expect(agruparPorDia([], AHORA)).toEqual([]);
  });
});
