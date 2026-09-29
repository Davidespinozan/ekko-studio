import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * PKG-02A (C02 · F01) — `useCentroPendientes`: si CUALQUIERA de los 4 counts
 * falla, `error=true` y NO se rellena con 0 (un 0 falso se leía "Todo al día").
 */

const h = vi.hoisted(() => ({
  // Un resultado por tabla; `usuarios` se consulta dos veces con el mismo mock.
  porTabla: {} as Record<string, { count: number | null; error: unknown }>
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'lt', 'gte']) c[m] = () => c;
      c.then = (cb: (v: unknown) => unknown) =>
        Promise.resolve(h.porTabla[tabla] ?? { count: 0, error: null }).then(cb);
      return c;
    }
  }
}));

import { useCentroPendientes } from '../useCentroPendientes';

describe('useCentroPendientes (PKG-02A)', () => {
  beforeEach(() => {
    h.porTabla = {
      usuarios: { count: 2, error: null },
      membresias: { count: 3, error: null },
      reservas: { count: 1, error: null }
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → conteos reales y error=false', async () => {
    const { result } = renderHook(() => useCentroPendientes());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.conteo).toEqual({ cobrosPendientes: 2, identidadPendiente: 2, membresiasVencidas: 3, noShows7d: 1 });
  });

  it('success con todo en 0 → error=false (vacío legítimo: sí es "Todo al día")', async () => {
    h.porTabla = { usuarios: { count: 0, error: null }, membresias: { count: 0, error: null }, reservas: { count: 0, error: null } };
    const { result } = renderHook(() => useCentroPendientes());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.conteo).toEqual({ cobrosPendientes: 0, identidadPendiente: 0, membresiasVencidas: 0, noShows7d: 0 });
  });

  it('un count falla → error=true y el conteo NO se completa con parciales ni con 0', async () => {
    h.porTabla.membresias = { count: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useCentroPendientes());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    // conserva el valor inicial (nunca cargó) en vez de {2,2,0,1}
    expect(result.current.conteo).toEqual({ cobrosPendientes: 0, identidadPendiente: 0, membresiasVencidas: 0, noShows7d: 0 });
  });

  it('refetch vuelve a consultar y limpia el error cuando ya responde', async () => {
    h.porTabla.reservas = { count: null, error: { message: 'timeout' } };
    const { result } = renderHook(() => useCentroPendientes());
    await waitFor(() => expect(result.current.error).toBe(true));
    h.porTabla.reservas = { count: 5, error: null };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.conteo.noShows7d).toBe(5);
  });
});
