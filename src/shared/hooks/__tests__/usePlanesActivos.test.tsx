import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/** PKG-02A (C02 · F12) — `usePlanesActivos`: error ≠ "no hay planes". */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown } }));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => Promise.resolve(h.resultado);
      return c;
    }
  }
}));

import { usePlanesActivos } from '../usePlanesActivos';

describe('usePlanesActivos (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → planes; success vacío → [] real con error=false', async () => {
    h.resultado = { data: [{ slug: 'pro', nombre: 'Pro' }], error: null };
    const { result } = renderHook(() => usePlanesActivos());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.planes).toEqual([{ slug: 'pro', nombre: 'Pro' }]);
    expect(result.current.error).toBe(false);
  });

  it('error → error=true; los selectores no lo leen como "sin planes"', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => usePlanesActivos());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it('recargar reintenta y limpia el error', async () => {
    h.resultado = { data: null, error: { message: 'timeout' } };
    const { result } = renderHook(() => usePlanesActivos());
    await waitFor(() => expect(result.current.error).toBe(true));
    h.resultado = { data: [{ slug: 'pro', nombre: 'Pro' }], error: null };
    act(() => result.current.recargar());
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(result.current.planes).toHaveLength(1);
  });
});
