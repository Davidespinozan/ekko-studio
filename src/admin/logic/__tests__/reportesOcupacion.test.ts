import { describe, it, expect } from 'vitest';
import {
  calcularOcupacion,
  horasAbiertasSemana,
  type RecursoLite,
  type ReservaLite
} from '../reportesOcupacion';

const HORARIO_LV = [
  { dia: 'lunes', inicio: '09:00', fin: '19:00' } // 10h
];

const EST1: RecursoLite = { id: 'r1', nombre: 'Estudio 1', cupos: 1, horarios: HORARIO_LV };

describe('horasAbiertasSemana', () => {
  it('suma la duración de los bloques', () => {
    expect(horasAbiertasSemana([
      { dia: 'lunes', inicio: '09:00', fin: '22:00' }, // 13h
      { dia: 'sabado', inicio: '10:00', fin: '20:00' } // 10h
    ])).toBe(23);
  });
  it('ignora bloques inválidos (fin <= inicio)', () => {
    expect(horasAbiertasSemana([{ dia: 'lunes', inicio: '20:00', fin: '19:00' }])).toBe(0);
  });
  it('sin horarios → 0', () => {
    expect(horasAbiertasSemana([])).toBe(0);
  });
});

describe('calcularOcupacion', () => {
  const r = (over: Partial<ReservaLite>): ReservaLite => ({
    recurso_id: 'r1',
    status: 'completada',
    duracion_min: 60,
    slot_inicio: '2026-06-15T14:00:00Z',
    ...over
  });

  it('ocupación = horas reservadas ÷ (horas abiertas × cupos × semanas)', () => {
    // 1 semana, 10h abiertas, cupos 1 → capacidad 10h. 2 reservas de 60min = 2h.
    const res = calcularOcupacion([EST1], [r({}), r({})], 7);
    expect(res.ocupacionPct).toBeCloseTo(20, 5); // 2/10
    expect(res.horasReservadas).toBe(2);
    expect(res.totalReservas).toBe(2);
  });

  it('asistencia = completadas ÷ (completadas + no_show)', () => {
    const res = calcularOcupacion([EST1], [
      r({ status: 'completada' }),
      r({ status: 'completada' }),
      r({ status: 'completada' }),
      r({ status: 'no_show' })
    ], 7);
    expect(res.asistenciaPct).toBeCloseTo(75, 5); // 3/4
    expect(res.noShows).toBe(1);
  });

  it('canceladas NO cuentan como ocupación ni demanda', () => {
    const res = calcularOcupacion([EST1], [
      r({ status: 'cancelada' }),
      r({ status: 'cancelada_admin' })
    ], 7);
    expect(res.totalReservas).toBe(0);
    expect(res.horasReservadas).toBe(0);
    expect(res.heatmapMax).toBe(0);
  });

  it('estudio sin horarios → ocupación null (capacidad 0), no rompe', () => {
    const sinHorario: RecursoLite = { id: 'r2', nombre: 'Sin horario', cupos: 1, horarios: [] };
    const res = calcularOcupacion([sinHorario], [{ recurso_id: 'r2', status: 'completada', duracion_min: 60, slot_inicio: '2026-06-15T14:00:00Z' }], 7);
    expect(res.porEstudio[0].ocupacionPct).toBeNull();
  });

  it('ocupación se topa a 100% (sobreventa no la infla)', () => {
    // 20 reservas de 60min = 20h vs capacidad 10h
    const muchas = Array.from({ length: 20 }, () => r({}));
    const res = calcularOcupacion([EST1], muchas, 7);
    expect(res.ocupacionPct).toBe(100);
  });

  it('heatmap agrupa por día/hora DEL ESTUDIO (Mazatlan), no del navegador', () => {
    // 2026-06-15T22:00Z → en Mazatlan (UTC-7) es lunes 15 a las 15:00.
    const res = calcularOcupacion([EST1], [
      { recurso_id: 'r1', status: 'completada', duracion_min: 60, slot_inicio: '2026-06-15T22:00:00Z' },
      { recurso_id: 'r1', status: 'confirmada', duracion_min: 60, slot_inicio: '2026-06-15T22:00:00Z' }
    ], 7);
    // lunes = fila 0 (lunes-primero), 15:00 hora del estudio
    expect(res.heatmap[0][15]).toBe(2);
    expect(res.heatmapMax).toBe(2);
  });

  it('estudios ordenados por reservas desc', () => {
    const est2: RecursoLite = { id: 'r2', nombre: 'Estudio 2', cupos: 1, horarios: HORARIO_LV };
    const res = calcularOcupacion([EST1, est2], [
      r({ recurso_id: 'r2' }),
      r({ recurso_id: 'r2' }),
      r({ recurso_id: 'r1' })
    ], 7);
    expect(res.porEstudio[0].id).toBe('r2');
    expect(res.porEstudio[0].reservas).toBe(2);
  });
});
