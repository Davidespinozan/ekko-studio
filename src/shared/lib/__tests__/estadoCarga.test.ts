import { describe, it, expect } from 'vitest';
import { estadoDeCarga } from '../estadoCarga';

/** PKG-02A (C02) — la tabla de verdad de EMPTY ≠ ERROR ≠ LOADING ≠ STALE. */
describe('estadoDeCarga', () => {
  it('sin dato: cargando → error → ok', () => {
    expect(estadoDeCarga({ isLoading: true, error: false, cargado: false })).toBe('cargando');
    expect(estadoDeCarga({ isLoading: false, error: true, cargado: false })).toBe('error');
    expect(estadoDeCarga({ isLoading: false, error: false, cargado: true })).toBe('ok');
  });

  it('con dato previo: refresh en curso NO es skeleton; refresh fallido es stale, nunca error ni vacío', () => {
    expect(estadoDeCarga({ isLoading: true, error: false, cargado: true })).toBe('ok');
    expect(estadoDeCarga({ isLoading: false, error: true, cargado: true })).toBe('stale');
  });

  it('el stale no se fabrica a partir del valor inicial: sin `cargado` un error es error', () => {
    expect(estadoDeCarga({ isLoading: false, error: true })).toBe('error');
    expect(estadoDeCarga({ isLoading: true, error: false })).toBe('cargando');
  });
});
