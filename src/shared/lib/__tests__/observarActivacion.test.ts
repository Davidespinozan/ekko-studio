import { describe, it, expect, vi } from 'vitest';
import { observarActivacion } from '../observarActivacion';

/** PKG-02B — observar es solo LEER: observada / no_observada / error; error ≠ ausencia; timeout ≠ fallo. */

const sinEspera = async () => {};

describe('observarActivacion', () => {
  it('observa en cuanto `listo` es true y devuelve el dato', async () => {
    const leer = vi.fn()
      .mockResolvedValueOnce({ data: { creditos: 0 }, error: null })
      .mockResolvedValueOnce({ data: { creditos: 2 }, error: null });
    const r = await observarActivacion({ leer, listo: (d: { creditos: number }) => d.creditos >= 2, esperar: sinEspera, intentos: 5 });
    expect(r).toEqual({ resultado: 'observada', dato: { creditos: 2 } });
    expect(leer).toHaveBeenCalledTimes(2);
  });

  it('agota los intentos con lecturas correctas → no_observada (NO fallo, conserva el último dato)', async () => {
    const leer = vi.fn().mockResolvedValue({ data: { creditos: 0 }, error: null });
    const r = await observarActivacion({ leer, listo: (d: { creditos: number }) => d.creditos >= 1, esperar: sinEspera, intentos: 3 });
    expect(r).toEqual({ resultado: 'no_observada', ultimo: { creditos: 0 } });
    expect(leer).toHaveBeenCalledTimes(3);
  });

  it('la última lectura falla → error (jamás "ausencia"); un fallo intermedio no detiene la observación', async () => {
    const leer = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    const r1 = await observarActivacion({ leer, listo: (d: { ok: boolean }) => d.ok, esperar: sinEspera, intentos: 3 });
    expect(r1.resultado).toBe('observada');

    const leer2 = vi.fn().mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const r2 = await observarActivacion({ leer: leer2, listo: () => true, esperar: sinEspera, intentos: 2 });
    expect(r2).toEqual({ resultado: 'error' });
  });

  it('una excepción al leer cuenta como error de lectura, no como dato', async () => {
    const leer = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const r = await observarActivacion({ leer, listo: () => true, esperar: sinEspera, intentos: 2 });
    expect(r).toEqual({ resultado: 'error' });
  });

  it('`data` null con lectura correcta no es "listo": sigue intentando', async () => {
    const leer = vi.fn().mockResolvedValue({ data: null, error: null });
    const listo = vi.fn(() => true);
    const r = await observarActivacion({ leer, listo, esperar: sinEspera, intentos: 2 });
    expect(r).toEqual({ resultado: 'no_observada', ultimo: null });
    expect(listo).not.toHaveBeenCalled();
  });

  it('cancelado → termina sin leer más (no_observada o error según la última lectura)', async () => {
    let cancel = false;
    const leer = vi.fn(async () => { cancel = true; return { data: { ok: false }, error: null }; });
    const r = await observarActivacion({ leer, listo: (d: { ok: boolean }) => d.ok, esperar: sinEspera, intentos: 5, cancelado: () => cancel });
    expect(r.resultado).toBe('no_observada');
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it('espera `cada` ms antes de cada lectura (default 2500 ms × 12 intentos)', async () => {
    const esperas: number[] = [];
    const leer = vi.fn().mockResolvedValue({ data: { ok: false }, error: null });
    await observarActivacion({ leer, listo: (d: { ok: boolean }) => d.ok, esperar: async (ms) => { esperas.push(ms); }, intentos: 3, cada: 100 });
    expect(esperas).toEqual([100, 100, 100]);
  });
});
