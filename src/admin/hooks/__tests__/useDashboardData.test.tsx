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
  result: { data: [] as unknown, count: 0, error: null as unknown }
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => h.tenant }));

vi.mock('@shared/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'order']) {
    builder[m] = () => builder;
  }
  builder.then = (cb: (v: unknown) => unknown) => Promise.resolve(h.result).then(cb);
  return { supabase: { from: () => builder } };
});

import { useDashboardData } from '../useAdminData';

beforeEach(() => {
  h.result = { data: [], count: 0, error: null };
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
});
