import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * ERROR-UI-FIX E-03 — `useDashboardData` chequea el .error de sus 9 queries:
 * si alguna falla, expone error=true y NO setea un dashboard en cero como si
 * fuera válido.
 *
 * Mock estable (vi.hoisted): `useTenant` devuelve referencia fija; el
 * resultado de las queries se controla por test. El builder es chainable +
 * thenable (las 9 queries van en un Promise.all).
 */

const h = vi.hoisted(() => ({
  tenant: { id: 't-1' },
  result: { data: [] as unknown, count: 0, error: null as unknown },
  // PKG-06F: la serie de 30 días viene de la RPC `reservas_por_dia_estudio`.
  serie: { data: [] as unknown, error: null as unknown },
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => h.tenant }));

vi.mock('@shared/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'order']) {
    builder[m] = () => builder;
  }
  builder.then = (cb: (v: unknown) => unknown) => Promise.resolve(h.result).then(cb);
  return {
    supabase: {
      from: () => builder,
      rpc: (fn: string, args: Record<string, unknown>) => {
        h.rpc.push({ fn, args });
        return Promise.resolve(h.serie);
      }
    }
  };
});

import { useDashboardData } from '../useAdminData';

beforeEach(() => {
  h.result = { data: [], count: 0, error: null };
  h.serie = { data: [], error: null };
  h.rpc.length = 0;
});

describe('useDashboardData · ERROR-UI-FIX E-03', () => {
  it('una query falla → error=true y data queda null (no ceros falsos)', async () => {
    h.result = { data: null, count: null as unknown as number, error: { message: 'falla RLS' } };
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('todas las queries OK → error=false y data poblada', async () => {
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.data).not.toBeNull();
  });

  it('PKG-06F (FR-62/63): la serie de 30 días son conteos de la base por día del estudio (sin filas crudas); 2,400 reservas en un día se ven completas', async () => {
    // La gráfica cubre los 30 días ANTERIORES a hoy (semántica vigente, sin cambio).
    const ayer = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
    h.serie = { data: [{ dia: ayer, n: 2400 }], error: null };
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(h.rpc).toHaveLength(1);
    expect(h.rpc[0].fn).toBe('reservas_por_dia_estudio');
    expect(Object.keys(h.rpc[0].args).sort()).toEqual(['p_desde', 'p_hasta']);
    const serie = result.current.data!.reservasUltimos30Dias;
    expect(serie).toHaveLength(30);
    expect(serie.reduce((a, d) => a + d.count, 0)).toBe(2400);
  });

  it('PKG-06F: si la RPC de la serie falla → error=true, nunca una gráfica en cero', async () => {
    h.serie = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useDashboardData());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.data).toBeNull();
  });
});
