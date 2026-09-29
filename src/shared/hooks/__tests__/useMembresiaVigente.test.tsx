import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * PKG-02A (C02 · F03) — `useMembresiaVigente`: error ≠ "sin membresía".
 */

const h = vi.hoisted(() => ({ resultado: { data: null as unknown, error: null as unknown }, lanza: false }));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = () => c;
      c.maybeSingle = () => (h.lanza ? Promise.reject(new Error('fetch failed')) : Promise.resolve(h.resultado));
      return c;
    }
  }
}));

import { useMembresiaVigente } from '../useMembresiaVigente';

const VIVA = { id: 'm1', status: 'activa', periodo_actual_fin: null, creditos_restantes: 3, stripe_subscription_id: null, cancel_at_period_end: false, created_at: '2026-01-01', tier: { slug: 'starter', nombre: 'Starter', tipo: 'hibrido' } };

describe('useMembresiaVigente (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: null, error: null };
    h.lanza = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success con membresía → datos, error=false', async () => {
    h.resultado = { data: VIVA, error: null };
    const { result } = renderHook(() => useMembresiaVigente('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.membresia?.id).toBe('m1');
    expect(result.current.error).toBe(false);
  });

  it('success sin membresía → null y error=false (ausencia REAL: sí "SIN MEMBRESÍA")', async () => {
    const { result } = renderHook(() => useMembresiaVigente('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.membresia).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it('la consulta devuelve error → error=true (la pantalla no puede decir "sin membresía")', async () => {
    h.resultado = { data: null, error: { message: 'permission denied for table membresias' } };
    const { result } = renderHook(() => useMembresiaVigente('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.membresia).toBeNull();
  });

  it('excepción de red → error=true, sin tumbar la pantalla', async () => {
    h.lanza = true;
    const { result } = renderHook(() => useMembresiaVigente('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it('con dato previo, un refetch fallido lo CONSERVA y marca error; el siguiente éxito lo limpia', async () => {
    h.resultado = { data: VIVA, error: null };
    const { result } = renderHook(() => useMembresiaVigente('u1'));
    await waitFor(() => expect(result.current.membresia?.id).toBe('m1'));
    h.resultado = { data: null, error: { message: 'timeout' } };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(true);
    expect(result.current.membresia?.id).toBe('m1');
    h.resultado = { data: null, error: null };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.membresia).toBeNull();
  });

  it('sin usuarioId → null, error=false, no consulta', async () => {
    const { result } = renderHook(() => useMembresiaVigente(null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
  });
});
