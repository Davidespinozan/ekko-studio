import { describe, it, expect } from 'vitest';
import {
  leerPenalizacionConfig,
  calcularPenalizacionNoShow,
  mensajeNoShow,
  PENALIZACION_DEFAULT
} from '../../netlify/functions/_lib/noShow';

const AHORA = new Date('2026-08-21T18:00:00.000Z');
const DIA = 24 * 60 * 60 * 1000;

describe('leerPenalizacionConfig', () => {
  it('config nulo → defaults (7 días, umbral 3)', () => {
    expect(leerPenalizacionConfig(null)).toEqual(PENALIZACION_DEFAULT);
    expect(leerPenalizacionConfig({})).toEqual(PENALIZACION_DEFAULT);
  });

  it('lee días y umbral (incluso como string, como los guarda un input)', () => {
    expect(leerPenalizacionConfig({ penalizaciones: { no_show_bloqueo_dias: '15', no_show_umbral: 2 } })).toEqual({
      bloqueo_dias: 15,
      umbral: 2
    });
  });

  it('0 días es válido (= no bloquear); basura/negativos caen al default; umbral mínimo 1', () => {
    expect(leerPenalizacionConfig({ penalizaciones: { no_show_bloqueo_dias: 0 } }).bloqueo_dias).toBe(0);
    expect(leerPenalizacionConfig({ penalizaciones: { no_show_bloqueo_dias: -3 } }).bloqueo_dias).toBe(7);
    expect(leerPenalizacionConfig({ penalizaciones: { no_show_bloqueo_dias: 'x' } }).bloqueo_dias).toBe(7);
    expect(leerPenalizacionConfig({ penalizaciones: { no_show_umbral: 0 } }).umbral).toBe(1);
  });
});

describe('calcularPenalizacionNoShow', () => {
  const cfg = { bloqueo_dias: 7, umbral: 3 };

  it('bajo el umbral: cuenta y NO bloquea', () => {
    const r = calcularPenalizacionNoShow({ countAntes: 0, bloqueadoHasta: null, cfg, ahora: AHORA });
    expect(r).toEqual({ countNuevo: 1, bloqueadoHasta: null, bloquea: false });
  });

  it('al alcanzar el umbral bloquea N días desde ahora', () => {
    const r = calcularPenalizacionNoShow({ countAntes: 2, bloqueadoHasta: null, cfg, ahora: AHORA });
    expect(r.countNuevo).toBe(3);
    expect(r.bloquea).toBe(true);
    expect(r.bloqueadoHasta).toBe(new Date(AHORA.getTime() + 7 * DIA).toISOString());
  });

  it('usa los días configurados por el tenant (15), no 7 fijos', () => {
    const r = calcularPenalizacionNoShow({ countAntes: 5, bloqueadoHasta: null, cfg: { bloqueo_dias: 15, umbral: 3 }, ahora: AHORA });
    expect(r.bloqueadoHasta).toBe(new Date(AHORA.getTime() + 15 * DIA).toISOString());
  });

  it('0 días = solo registrar la falta, nunca bloquear (aunque pase el umbral)', () => {
    const r = calcularPenalizacionNoShow({ countAntes: 9, bloqueadoHasta: null, cfg: { bloqueo_dias: 0, umbral: 3 }, ahora: AHORA });
    expect(r).toEqual({ countNuevo: 10, bloqueadoHasta: null, bloquea: false });
  });

  it('umbral configurable (1 = bloquea a la primera)', () => {
    const r = calcularPenalizacionNoShow({ countAntes: 0, bloqueadoHasta: null, cfg: { bloqueo_dias: 3, umbral: 1 }, ahora: AHORA });
    expect(r.bloquea).toBe(true);
  });

  it('un bloqueo vigente más largo se extiende desde su fin (GREATEST), uno vencido se ignora', () => {
    const vigente = new Date(AHORA.getTime() + 10 * DIA).toISOString();
    const r1 = calcularPenalizacionNoShow({ countAntes: 3, bloqueadoHasta: vigente, cfg, ahora: AHORA });
    expect(r1.bloqueadoHasta).toBe(new Date(AHORA.getTime() + 17 * DIA).toISOString());

    const vencido = new Date(AHORA.getTime() - 1 * DIA).toISOString();
    const r2 = calcularPenalizacionNoShow({ countAntes: 3, bloqueadoHasta: vencido, cfg, ahora: AHORA });
    expect(r2.bloqueadoHasta).toBe(new Date(AHORA.getTime() + 7 * DIA).toISOString());
  });
});

describe('mensajeNoShow', () => {
  const cfg = { bloqueo_dias: 7, umbral: 3 };

  it('sin bloqueo: informa faltas y cuántas quedan', () => {
    const m = mensajeNoShow({ folio: 'EKK-1', resultado: { countNuevo: 1, bloqueadoHasta: null, bloquea: false }, cfg });
    expect(m.titulo).toMatch(/inasistencia/i);
    expect(m.mensaje).toContain('(EKK-1)');
    expect(m.mensaje).toContain('1 de 3');
    expect(m.mensaje).toContain('2 veces más');
  });

  it('con bloqueo: dice hasta cuándo', () => {
    const m = mensajeNoShow({
      folio: null,
      resultado: { countNuevo: 3, bloqueadoHasta: '2026-08-28T18:00:00.000Z', bloquea: true },
      cfg
    });
    expect(m.titulo).toMatch(/bloqueada/i);
    expect(m.mensaje).toMatch(/hasta el 28 ago/);
  });

  it('con 0 días no amenaza con bloqueo', () => {
    const m = mensajeNoShow({ folio: null, resultado: { countNuevo: 4, bloqueadoHasta: null, bloquea: false }, cfg: { bloqueo_dias: 0, umbral: 3 } });
    expect(m.mensaje).not.toMatch(/bloquea/);
  });
});
