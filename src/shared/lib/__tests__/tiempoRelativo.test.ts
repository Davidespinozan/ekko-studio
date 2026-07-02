import { describe, it, expect } from 'vitest';
import { tiempoRelativo } from '../tiempoRelativo';

const AHORA = new Date('2026-07-07T12:00:00Z');

function haceSegundos(s: number): string {
  return new Date(AHORA.getTime() - s * 1000).toISOString();
}

describe('tiempoRelativo', () => {
  it('menos de 45s → "ahora"', () => {
    expect(tiempoRelativo(haceSegundos(10), AHORA)).toBe('ahora');
  });

  it('minutos', () => {
    expect(tiempoRelativo(haceSegundos(5 * 60), AHORA)).toBe('hace 5 min');
  });

  it('horas', () => {
    expect(tiempoRelativo(haceSegundos(3 * 3600), AHORA)).toBe('hace 3 h');
  });

  it('ayer', () => {
    expect(tiempoRelativo(haceSegundos(24 * 3600), AHORA)).toBe('ayer');
  });

  it('varios días', () => {
    expect(tiempoRelativo(haceSegundos(3 * 24 * 3600), AHORA)).toBe('hace 3 días');
  });

  it('semanas', () => {
    expect(tiempoRelativo(haceSegundos(14 * 24 * 3600), AHORA)).toBe('hace 2 semanas');
  });

  it('más de un mes → fecha corta', () => {
    const r = tiempoRelativo(haceSegundos(60 * 24 * 3600), AHORA);
    expect(r).toMatch(/may/i);
  });

  it('fecha inválida → cadena vacía', () => {
    expect(tiempoRelativo('no-fecha', AHORA)).toBe('');
  });
});
