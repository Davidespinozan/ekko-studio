import { describe, it, expect } from 'vitest';
import { clasificarReservasHoy } from '../clasificarReservasHoy';

const NOW = new Date('2026-08-21T18:00:00.000Z').getTime();
const min = (n: number) => n * 60_000;

function reserva(status: string, inicioOffsetMin: number, duracionMin = 60) {
  const inicio = NOW + min(inicioOffsetMin);
  return {
    id: `${status}-${inicioOffsetMin}`,
    status,
    slot_inicio: new Date(inicio).toISOString(),
    slot_fin: new Date(inicio + min(duracionMin)).toISOString()
  };
}

describe('clasificarReservasHoy', () => {
  it('confirmada en curso o por empezar (−15 min) → llegando', () => {
    const r = clasificarReservasHoy([reserva('confirmada', -30), reserva('confirmada', 10)], { esHoy: true, now: NOW });
    expect(r.llegando.map((x) => x.id)).toEqual(['confirmada--30', 'confirmada-10']);
    expect(r.resto).toEqual([]);
    expect(r.faltantes).toEqual([]);
  });

  it('canceladas / completadas / no_show en ventana NO son "llegando" (fantasmas)', () => {
    const r = clasificarReservasHoy(
      [reserva('cancelada', -10), reserva('cancelada_admin', -10), reserva('completada', -10), reserva('no_show', -10)],
      { esHoy: true, now: NOW }
    );
    expect(r.llegando).toEqual([]);
    expect(r.faltantes).toEqual([]);
    expect(r.resto).toHaveLength(4);
  });

  it('confirmada cuyo horario ya terminó sin check-in → faltante', () => {
    const r = clasificarReservasHoy([reserva('confirmada', -120)], { esHoy: true, now: NOW });
    expect(r.faltantes).toHaveLength(1);
    expect(r.llegando).toEqual([]);
  });

  it('no_show ya marcado no vuelve a salir como faltante', () => {
    const r = clasificarReservasHoy([reserva('no_show', -120)], { esHoy: true, now: NOW });
    expect(r.faltantes).toEqual([]);
    expect(r.resto).toHaveLength(1);
  });

  it('confirmada lejos en el futuro → resto', () => {
    const r = clasificarReservasHoy([reserva('confirmada', 180)], { esHoy: true, now: NOW });
    expect(r.resto).toHaveLength(1);
    expect(r.llegando).toEqual([]);
  });

  it('si la fecha vista no es hoy, todo va a resto', () => {
    const r = clasificarReservasHoy([reserva('confirmada', -10), reserva('confirmada', -120)], { esHoy: false, now: NOW });
    expect(r.llegando).toEqual([]);
    expect(r.faltantes).toEqual([]);
    expect(r.resto).toHaveLength(2);
  });
});
