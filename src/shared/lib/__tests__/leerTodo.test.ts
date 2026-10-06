import { describe, it, expect, vi } from 'vitest';
import { leerTodo, LecturaIncompletaError, type Pagina } from '../leerTodo';

/**
 * PKG-06F (FR-62) · una lista acotada se lee COMPLETA por páginas aunque el
 * servidor corte cada respuesta en 1000 (`max_rows`); si no se puede completar,
 * es un error — jamás una lista truncada que parezca completa.
 */

/** Simula PostgREST: corta en `cap` filas por respuesta y da el conteo exacto. */
function servidor<T>(filas: T[], cap = 1000, opts: { sinConteo?: boolean; cortarEn?: number } = {}) {
  const llamadas: Array<[number, number]> = [];
  const pagina: Pagina<T> = (desde, hasta) => {
    llamadas.push([desde, hasta]);
    const tope = Math.min(hasta + 1, desde + cap, opts.cortarEn ?? Infinity);
    return Promise.resolve({ data: filas.slice(desde, tope), error: null, count: opts.sinConteo ? null : filas.length });
  };
  return { pagina, llamadas };
}

const n = (k: number) => Array.from({ length: k }, (_, i) => ({ id: i }));

describe('leerTodo', () => {
  it('1 · menos de 1000 → una sola llamada', async () => {
    const s = servidor(n(999));
    expect(await leerTodo(s.pagina)).toHaveLength(999);
    expect(s.llamadas).toEqual([[0, 999]]);
  });

  it('2 · exactamente 1000 → completa sin pedir de más', async () => {
    const s = servidor(n(1000));
    expect(await leerTodo(s.pagina)).toHaveLength(1000);
    expect(s.llamadas).toHaveLength(1);
  });

  it('3/36 · 2,345 filas con tope de 1000 → las 2,345, en orden, sin duplicados', async () => {
    const s = servidor(n(2345));
    const r = await leerTodo(s.pagina);
    expect(r).toHaveLength(2345);
    expect(r.map((x) => x.id)).toEqual(n(2345).map((x) => x.id));
    expect(s.llamadas).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('4 · si el servidor recorta MÁS de lo esperado (tope de 500), igual se completa', async () => {
    const s = servidor(n(1200), 500);
    expect(await leerTodo(s.pagina)).toHaveLength(1200);
  });

  it('36 · si las páginas dejan de llegar antes del total → LecturaIncompletaError (nunca lista parcial)', async () => {
    const s = servidor(n(1500), 1000, { cortarEn: 1000 });
    await expect(leerTodo(s.pagina)).rejects.toBeInstanceOf(LecturaIncompletaError);
  });

  it('sin conteo exacto o por encima del máximo de seguridad → error explícito', async () => {
    await expect(leerTodo(servidor(n(10), 1000, { sinConteo: true }).pagina)).rejects.toThrow(/conteo exacto/);
    await expect(leerTodo(servidor(n(60), 1000).pagina, { maxFilas: 50 })).rejects.toThrow(/superan el máximo/);
  });

  it('13 · el error de una página se propaga tal cual (el hook lo muestra como error, no como vacío)', async () => {
    const pagina = vi.fn<Pagina<{ id: number }>>()
      .mockResolvedValueOnce({ data: n(1000), error: null, count: 1500 })
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' }, count: null });
    await expect(leerTodo(pagina)).rejects.toEqual({ message: 'timeout' });
  });

  it('28 · lista vacía → [] (vacío real)', async () => {
    expect(await leerTodo(servidor([]).pagina)).toEqual([]);
  });
});
