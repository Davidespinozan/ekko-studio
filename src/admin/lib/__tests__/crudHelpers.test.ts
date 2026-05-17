import { describe, it, expect } from 'vitest';
import { generateUniqueSlug } from '../crudHelpers';

describe('generateUniqueSlug', () => {
  it('agrega -copia cuando no hay colisión con el sufijo base', () => {
    expect(generateUniqueSlug('pro', ['basica', 'pro'])).toBe('pro-copia');
  });

  it('agrega sufijo numérico si -copia ya existe', () => {
    expect(generateUniqueSlug('pro', ['pro', 'pro-copia'])).toBe('pro-copia-2');
  });

  it('aumenta el sufijo hasta encontrar uno libre', () => {
    expect(
      generateUniqueSlug('pro', ['pro', 'pro-copia', 'pro-copia-2', 'pro-copia-3'])
    ).toBe('pro-copia-4');
  });

  it('funciona si baseSlug no está en la lista (igual sufija -copia)', () => {
    expect(generateUniqueSlug('plus', ['basica', 'pro'])).toBe('plus-copia');
  });

  it('lista vacía → primer candidato -copia', () => {
    expect(generateUniqueSlug('starter', [])).toBe('starter-copia');
  });

  it('no se confunde con slugs que solo coinciden parcialmente', () => {
    // "pro-anual" empieza con "pro" pero NO es "pro-copia"
    expect(generateUniqueSlug('pro', ['pro-anual', 'pro-mensual'])).toBe('pro-copia');
  });
});
