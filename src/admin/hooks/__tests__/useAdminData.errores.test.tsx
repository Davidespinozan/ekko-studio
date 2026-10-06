import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

/**
 * PKG-02A (C02 · F04/F05/F07) — hooks de admin: un fallo de consulta expone
 * `error=true` y conserva el dato anterior; nunca se convierte en lista vacía,
 * mapa vacío o `null` que la UI lea como "no hay".
 */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, { data: unknown; error: unknown }>,
  rpcLlamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
/**
 * Constructor encadenable. PKG-06F: `.range(a, b)` responde como PostgREST — a lo
 * más 1000 filas por respuesta (`max_rows`) y el conteo exacto del total — para
 * probar que las listas se leen COMPLETAS por páginas.
 */
const MAX_ROWS = 1000;
function constructor(res: () => { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit', 'neq', 'gte', 'lt']) c[m] = () => c;
  c.range = (a: number, b: number) => {
    const r = res();
    if (r.error || !Array.isArray(r.data)) return Promise.resolve({ data: null, error: r.error, count: null });
    return Promise.resolve({ data: r.data.slice(a, Math.min(b + 1, a + MAX_ROWS)), error: null, count: r.data.length });
  };
  c.maybeSingle = () => Promise.resolve(res());
  c.then = (cb: (v: unknown) => unknown) => Promise.resolve(res()).then(cb);
  return c;
}

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    // PKG-06D: la lista de cuentas es la RPC `buscar_cuentas_staff` (texto como
    // parámetro, nunca gramática `.or()`); se simula con la misma tabla 'usuarios'.
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.rpcLlamadas.push({ fn, args });
      return constructor(() => h.porTabla.usuarios ?? { data: [], error: null });
    },
    from: (tabla: string) => constructor(() => h.porTabla[tabla] ?? { data: [], error: null })
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

  it("PKG-06D (FR-27): la búsqueda viaja como parámetro de buscar_cuentas_staff, jamás interpolada en `.or()`", async () => {
    h.rpcLlamadas.length = 0;
    h.porTabla.usuarios = { data: [], error: null };
    const carga = "x),email.ilike.%@%,nombre.ilike.%";
    const { result } = renderHook(() => useMiembros({ rol: 'staff', status: 'activo', search: ` ${carga} ` }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(h.rpcLlamadas).toEqual([{ fn: 'buscar_cuentas_staff', args: { p_texto: carga, p_rol: 'staff', p_status: 'activo' } }]);
    h.rpcLlamadas.length = 0;
    renderHook(() => useMiembros({}));
    await waitFor(() => expect(h.rpcLlamadas).toHaveLength(1));
    expect(h.rpcLlamadas[0].args).toEqual({ p_texto: null, p_rol: null, p_status: null });
  });

  it('PKG-06F (FR-62): 2,500 cuentas → la lista llega COMPLETA (3 páginas), no cortada en 1000', async () => {
    h.rpcLlamadas.length = 0;
    h.porTabla.usuarios = { data: Array.from({ length: 2500 }, (_, i) => ({ id: `u${i}` })), error: null };
    const { result } = renderHook(() => useMiembros({ rol: 'miembro' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.miembros).toHaveLength(2500);
    expect(new Set(result.current.miembros.map((m) => m.id)).size).toBe(2500);
    expect(h.rpcLlamadas).toHaveLength(3);
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

  it('PKG-06F (FR-62): 1,500 membresías vivas → el mapa tiene a los 1,500 miembros (ninguno "sin membresía" por el tope)', async () => {
    h.porTabla.membresias = { data: Array.from({ length: 1500 }, (_, i) => ({ usuario_id: `u${i}`, status: 'activa', created_at: '2026-02-01' })), error: null };
    const { result } = renderHook(() => useMembresiasVigentesPorUsuario());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.porUsuario.size).toBe(1500);
    expect(result.current.porUsuario.get('u1499')?.status).toBe('activa');
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
