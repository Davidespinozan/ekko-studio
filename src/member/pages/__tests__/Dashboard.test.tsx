import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * ERROR-UI-FIX E-02 — `useProximasReservas` expone isLoading y error reales:
 * un fallo de carga ya NO se confunde con "el miembro no tiene reservas".
 *
 * Mock estable (vi.hoisted): el resultado de la query se controla por test.
 * El builder es chainable + thenable y devuelve referencia fija.
 */

const h = vi.hoisted(() => ({
  result: { data: [] as unknown, error: null as unknown }
}));

vi.mock('@shared/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) {
    builder[m] = () => builder;
  }
  builder.then = (cb: (v: unknown) => unknown) => Promise.resolve(h.result).then(cb);
  return { supabase: { from: () => builder } };
});

import { useProximasReservas } from '../Dashboard';

beforeEach(() => {
  h.result = { data: [], error: null };
});

describe('useProximasReservas · ERROR-UI-FIX E-02', () => {
  it('query OK con [] → isLoading false, error false (empty real)', async () => {
    const { result } = renderHook(() => useProximasReservas('u-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.reservas).toEqual([]);
  });

  it('query con error → error=true (NO un falso "sin reservas")', async () => {
    h.result = { data: null, error: { message: 'falla de red' } };
    const { result } = renderHook(() => useProximasReservas('u-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it('sin usuarioId → no queda colgado en loading', async () => {
    const { result } = renderHook(() => useProximasReservas(undefined));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
  });
});
