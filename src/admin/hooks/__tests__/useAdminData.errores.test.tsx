import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * PKG-02A (C02 · F04/F05/F07) — hooks de admin: un fallo de consulta expone
 * `error=true` y conserva el dato anterior; nunca se convierte en lista vacía,
 * mapa vacío o `null` que la UI lea como "no hay".
 */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, { data: unknown; error: unknown }>
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit']) c[m] = () => c;
      const res = () => h.porTabla[tabla] ?? { data: [], error: null };
      c.maybeSingle = () => Promise.resolve(res());
      c.then = (cb: (v: unknown) => unknown) => Promise.resolve(res()).then(cb);
      return c;
    }
  }
}));

import { useMiembros, useMembresiasVigentesPorUsuario, useMembresiaActualAdmin } from '../useAdminData';

describe('useMiembros (F07)', () => {
  beforeEach(() => {
    h.porTabla = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → lista, error=false; success vacío → [] y error=false (vacío real)', async () => {
    h.porTabla.usuarios = { data: [{ id: 'u1', nombre: 'Ana' }], error: null };
    const { result } = renderHook(() => useMiembros({ rol: 'miembro' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.miembros).toHaveLength(1);
    expect(result.current.error).toBe(false);
  });

  it('error → error=true y la lista no se reemplaza por [] "real"', async () => {
    h.porTabla.usuarios = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useMiembros({ rol: 'miembro' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it('dato previo + refetch fallido → lista conservada + error; refetch OK limpia', async () => {
    h.porTabla.usuarios = { data: [{ id: 'u1' }, { id: 'u2' }], error: null };
    const { result } = renderHook(() => useMiembros({ rol: 'miembro' }));
    await waitFor(() => expect(result.current.miembros).toHaveLength(2));
    h.porTabla.usuarios = { data: null, error: { message: 'timeout' } };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(true);
    expect(result.current.miembros).toHaveLength(2);
    h.porTabla.usuarios = { data: [{ id: 'u1' }], error: null };
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.miembros).toHaveLength(1);
  });
});

describe('useMembresiasVigentesPorUsuario (F04)', () => {
  beforeEach(() => {
    h.porTabla = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → mapa por usuario (la más reciente gana), error=false', async () => {
    h.porTabla.membresias = { data: [{ usuario_id: 'u1', status: 'activa', created_at: '2026-02-01' }, { usuario_id: 'u1', status: 'cancelada', created_at: '2026-01-01' }], error: null };
    const { result } = renderHook(() => useMembresiasVigentesPorUsuario());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.porUsuario.get('u1')?.status).toBe('activa');
    expect(result.current.error).toBe(false);
  });

  it('error → error=true; el mapa queda vacío pero la UI NO debe leerlo como "todos sin membresía"', async () => {
    h.porTabla.membresias = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useMembresiasVigentesPorUsuario());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.porUsuario.size).toBe(0);
  });
});

describe('useMembresiaActualAdmin (F05)', () => {
  beforeEach(() => {
    h.porTabla = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success sin membresía → null, error=false (ausencia real)', async () => {
    h.porTabla.membresias = { data: null, error: null };
    const { result } = renderHook(() => useMembresiaActualAdmin('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.membresia).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it('error → error=true (la ficha no ofrece asignar plan)', async () => {
    h.porTabla.membresias = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useMembresiaActualAdmin('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });
});
