import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * PKG-02A (C02 · F06) — `useResumenMiembro`: si una de las 4 consultas falla,
 * `error=true` y el resumen NO se rellena con 0 créditos / 0 sesiones / sin plan.
 */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, { data?: unknown; count?: number | null; error: unknown }>
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) c[m] = () => c;
      const res = () => h.porTabla[tabla] ?? { data: [], count: 0, error: null };
      c.maybeSingle = () => Promise.resolve(res());
      c.then = (cb: (v: unknown) => unknown) => Promise.resolve(res()).then(cb);
      return c;
    }
  }
}));

import { useResumenMiembro } from '../useResumenMiembro';

describe('useResumenMiembro (PKG-02A)', () => {
  beforeEach(() => {
    h.porTabla = {
      reservas: { data: null, count: 2, error: null },
      membresias: { data: [{ status: 'activa', creditos_restantes: 4, periodo_actual_fin: null }], error: null },
      tiers: { data: { nombre: 'Starter', tipo: 'hibrido', reglas: { max_invitados: 1 } }, error: null }
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → resumen real, error=false', async () => {
    const { result } = renderHook(() => useResumenMiembro('u1', 't1', 'starter'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.resumen.membresia?.creditosRestantes).toBe(4);
    expect(result.current.resumen.tier?.nombre).toBe('Starter');
    expect(result.current.resumen.proximasCount).toBe(2);
  });

  it('success sin membresía ni sesiones → 0 y null REALES, error=false', async () => {
    h.porTabla.reservas = { data: null, count: 0, error: null };
    h.porTabla.membresias = { data: [], error: null };
    const { result } = renderHook(() => useResumenMiembro('u1', 't1', null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.resumen.membresia).toBeNull();
    expect(result.current.resumen.sesionesEsteMes).toBe(0);
  });

  it('la consulta de membresía falla → error=true; NO se afirma 0 créditos ni "sin plan"', async () => {
    h.porTabla.membresias = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useResumenMiembro('u1', 't1', 'starter'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    // Valor inicial conservado; la UI debe mirar `error`, no estos campos.
    expect(result.current.resumen.membresia).toBeNull();
  });

  it('la consulta de reservas falla → error=true aunque la membresía haya respondido (sin parciales)', async () => {
    h.porTabla.reservas = { data: null, count: null, error: { message: 'timeout' } };
    const { result } = renderHook(() => useResumenMiembro('u1', 't1', 'starter'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.resumen.tier).toBeNull(); // no se mezcló el tier cargado con conteos fallidos
  });

  it('dato previo + refetch fallido → resumen conservado; refetch OK lo limpia', async () => {
    const { result } = renderHook(() => useResumenMiembro('u1', 't1', 'starter'));
    await waitFor(() => expect(result.current.resumen.membresia?.creditosRestantes).toBe(4));
    h.porTabla.membresias = { data: null, error: { message: 'timeout' } };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(true);
    expect(result.current.resumen.membresia?.creditosRestantes).toBe(4);
    h.porTabla.membresias = { data: [{ status: 'activa', creditos_restantes: 3, periodo_actual_fin: null }], error: null };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.resumen.membresia?.creditosRestantes).toBe(3);
  });
});
