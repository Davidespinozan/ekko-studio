import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { estadoDeCarga } from '@shared/lib/estadoCarga';

/** PKG-02A (C02 · F10) — `useReservasRango`: fallo de consulta ≠ período vacío. */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown } }));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'lt']) c[m] = () => c;
      c.order = () => Promise.resolve(h.resultado);
      return c;
    }
  }
}));

import { useReservasRango } from '../useReservasRango';

const INICIO = new Date('2026-09-28T00:00:00Z');
const FIN = new Date('2026-09-29T00:00:00Z');

describe('useReservasRango (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success con [] → cargado, error=false → estado ok (vacío legítimo)', async () => {
    const { result } = renderHook(() => useReservasRango(INICIO, FIN));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.cargado).toBe(true);
    expect(estadoDeCarga(result.current)).toBe('ok');
  });

  it('primer fetch falla → error=true, cargado=false → estado error (no "sin reservas")', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useReservasRango(INICIO, FIN));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.cargado).toBe(false);
    expect(estadoDeCarga(result.current)).toBe('error');
  });

  it('dato previo + refetch fallido → lista conservada, estado stale; refetch OK limpia', async () => {
    h.resultado = { data: [{ id: 'r1', slot_inicio: INICIO.toISOString() }], error: null };
    const { result } = renderHook(() => useReservasRango(INICIO, FIN));
    await waitFor(() => expect(result.current.reservas).toHaveLength(1));
    h.resultado = { data: null, error: { message: 'timeout' } };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(true);
    expect(result.current.reservas).toHaveLength(1);
    expect(estadoDeCarga(result.current)).toBe('stale');
    h.resultado = { data: [], error: null };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.reservas).toHaveLength(0);
    expect(estadoDeCarga(result.current)).toBe('ok');
  });
});
