import { describe, it, expect } from 'vitest';
import { construirPendientes, totalPendientes, type ConteoPendientes } from '../centroPendientes';

const CERO: ConteoPendientes = { cobrosPendientes: 0, identidadPendiente: 0, membresiasVencidas: 0, noShows7d: 0, materialPendiente: 0, operacion: 0 };

describe('construirPendientes', () => {
  it('sin pendientes → lista vacía', () => {
    expect(construirPendientes(CERO)).toEqual([]);
  });

  it('omite los que tienen count 0', () => {
    const items = construirPendientes({ ...CERO, cobrosPendientes: 3 });
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe('cobros');
    // A la lista de QUIÉNES deben, no a /admin/cobros (esa es la conexión con Stripe).
    expect(items[0].to).toBe('/admin/miembros?status=pendiente_pago');
  });

  it('cada pendiente lleva a la lista YA filtrada donde se resuelve', () => {
    const items = construirPendientes({ cobrosPendientes: 1, identidadPendiente: 1, membresiasVencidas: 1, noShows7d: 1, materialPendiente: 1, operacion: 0 });
    const destino = Object.fromEntries(items.map((i) => [i.key, i.to]));
    expect(destino.vencidas).toBe('/admin/miembros?filtro=vencidas');
    expect(destino.identidad).toBe('/admin/miembros?filtro=identidad');
    expect(destino.cobros).toBe('/admin/miembros?status=pendiente_pago');
    expect(destino.material).toBe('/admin/miembros?filtro=material_pendiente');
  });

  it('ordena por severidad: danger antes que warn antes que neutral', () => {
    const items = construirPendientes({ cobrosPendientes: 1, identidadPendiente: 1, membresiasVencidas: 1, noShows7d: 1, materialPendiente: 1, operacion: 0 });
    expect(items.map((i) => i.key)).toEqual(['vencidas', 'cobros', 'identidad', 'material', 'noshow']);
  });

  it('singular vs plural en el título de material', () => {
    expect(construirPendientes({ ...CERO, materialPendiente: 1 })[0].title).toBe('Sesión sin material');
    expect(construirPendientes({ ...CERO, materialPendiente: 2 })[0].title).toBe('Sesiones sin material');
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
    expect(totalPendientes({ cobrosPendientes: 2, identidadPendiente: 3, membresiasVencidas: 1, noShows7d: 4, materialPendiente: 5, operacion: 0 })).toBe(15);
  });
});

describe('PKG-03A · pendientes operativos', () => {
  it('va primero (requiere decisión) y lleva a /admin/operacion; cuenta en el total', () => {
    const items = construirPendientes({ ...CERO, operacion: 2, noShows7d: 5, cobrosPendientes: 1 });
    expect(items[0]).toMatchObject({ key: 'operacion', tono: 'dang', to: '/admin/operacion', count: 2, title: 'Pendientes operativos' });
    expect(construirPendientes({ ...CERO, operacion: 1 })[0].title).toBe('Pendiente operativo');
    expect(totalPendientes({ ...CERO, operacion: 3 })).toBe(3);
    expect(construirPendientes(CERO).some((i) => i.key === 'operacion')).toBe(false);
  });
});
