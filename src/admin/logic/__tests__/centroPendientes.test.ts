import { describe, it, expect } from 'vitest';
import { construirPendientes, totalPendientes, type ConteoPendientes } from '../centroPendientes';

const CERO: ConteoPendientes = { cobrosPendientes: 0, identidadPendiente: 0, membresiasVencidas: 0, noShows7d: 0 };

describe('construirPendientes', () => {
  it('sin pendientes → lista vacía', () => {
    expect(construirPendientes(CERO)).toEqual([]);
  });

  it('omite los que tienen count 0', () => {
    const items = construirPendientes({ ...CERO, cobrosPendientes: 3 });
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe('cobros');
    expect(items[0].to).toBe('/admin/cobros');
  });

  it('ordena por severidad: danger antes que warn antes que neutral', () => {
    const items = construirPendientes({ cobrosPendientes: 1, identidadPendiente: 1, membresiasVencidas: 1, noShows7d: 1 });
    expect(items.map((i) => i.key)).toEqual(['vencidas', 'cobros', 'identidad', 'noshow']);
  });

  it('dentro del mismo tono, mayor cantidad primero', () => {
    const items = construirPendientes({ ...CERO, cobrosPendientes: 2, identidadPendiente: 5 });
    // ambos warn → identidad (5) antes que cobros (2)
    expect(items.map((i) => i.key)).toEqual(['identidad', 'cobros']);
  });

  it('singular vs plural en el título', () => {
    expect(construirPendientes({ ...CERO, cobrosPendientes: 1 })[0].title).toBe('Cobro pendiente');
    expect(construirPendientes({ ...CERO, cobrosPendientes: 2 })[0].title).toBe('Cobros pendientes');
  });

  it('totalPendientes suma todo', () => {
    expect(totalPendientes({ cobrosPendientes: 2, identidadPendiente: 3, membresiasVencidas: 1, noShows7d: 4 })).toBe(10);
  });
});
