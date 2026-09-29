import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/** PKG-02A (C02 · F11) — `useRecursosDelTenant`: error ≠ "no hay estudios". */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown } }));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: null }) }));
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

import { useRecursosDelTenant } from '../useReservas';

describe('useRecursosDelTenant (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → recursos, error=false; success vacío → [] real', async () => {
    h.resultado = { data: [{ id: 'r1', nombre: 'Set A' }], error: null };
    const { result } = renderHook(() => useRecursosDelTenant());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.recursos).toHaveLength(1);
    expect(result.current.error).toBe(false);
  });

  it('error → error=true (la UI no dice "sin estudios")', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useRecursosDelTenant());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.recursos).toEqual([]);
  });

  it('recargar vuelve a consultar y limpia el error', async () => {
    h.resultado = { data: null, error: { message: 'timeout' } };
    const { result } = renderHook(() => useRecursosDelTenant());
    await waitFor(() => expect(result.current.error).toBe(true));
    h.resultado = { data: [{ id: 'r1' }], error: null };
    act(() => result.current.recargar());
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(result.current.recursos).toHaveLength(1);
  });
});
