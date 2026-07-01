import { describe, it, expect } from 'vitest';
import { parseBeneficios } from '@shared/lib/beneficios';

/**
 * parseBeneficios: el bug era que la versión vieja descartaba los objetos
 * { label, incluido } (solo aceptaba strings) → los beneficios reales se perdían.
 */

describe('parseBeneficios', () => {
  it('lee objetos { label, incluido }', () => {
    const r = parseBeneficios([
      { label: 'Grabación todos los días', incluido: true },
      { label: 'Miniaturas IA', incluido: false }
    ]);
    expect(r).toEqual([
      { label: 'Grabación todos los días', incluido: true },
      { label: 'Miniaturas IA', incluido: false }
    ]);
  });

  it('incluido ausente → true por defecto', () => {
    expect(parseBeneficios([{ label: 'X' }])).toEqual([{ label: 'X', incluido: true }]);
  });

  it('tolera strings legacy (los trata como incluidos)', () => {
    expect(parseBeneficios(['Acceso diario'])).toEqual([{ label: 'Acceso diario', incluido: true }]);
  });

  it('acepta un jsonb como string', () => {
    expect(parseBeneficios('[{"label":"A","incluido":false}]')).toEqual([{ label: 'A', incluido: false }]);
  });

  it('descarta entradas inválidas y no-arrays', () => {
    expect(parseBeneficios([{ nope: 1 }, '', 42, null])).toEqual([]);
    expect(parseBeneficios(null)).toEqual([]);
    expect(parseBeneficios('no-json')).toEqual([]);
    expect(parseBeneficios({})).toEqual([]);
  });
});
