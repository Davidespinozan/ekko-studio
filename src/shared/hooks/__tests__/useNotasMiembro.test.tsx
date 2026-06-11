import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * Bloque E: useNotasMiembro — estados loading/error/empty y refetch tras crear.
 */

const { mockOrder, mockInsert, AUTOR } = vi.hoisted(() => ({
  mockOrder: vi.fn(),
  mockInsert: vi.fn(),
  AUTOR: { id: 'u1', tenant_id: 't1', rol: 'recepcionista' }
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ order: mockOrder }) }),
      insert: mockInsert
    })
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: AUTOR }) }));

import { useNotasMiembro } from '../useNotasMiembro';

const NOTA = {
  id: 'n1',
  contenido: 'Trae foto para el reset',
  autor_id: 'u1',
  autor_rol: 'recepcionista',
  creada_at: '2026-06-11T10:00:00Z',
  actualizada_at: null,
  autor: { nombre: 'Recep' }
};

describe('useNotasMiembro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrder.mockReset();
    mockInsert.mockResolvedValue({ error: null });
  });

  it('loading → data', async () => {
    mockOrder.mockResolvedValue({ data: [NOTA], error: null });
    const { result } = renderHook(() => useNotasMiembro('m1'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.notas).toHaveLength(1);
  });

  it('error', async () => {
    mockOrder.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useNotasMiembro('m1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.notas).toHaveLength(0);
  });

  it('empty', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useNotasMiembro('m1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notas).toHaveLength(0);
  });

  it('createNota inserta y refetcha', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useNotasMiembro('m1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.createNota('Nueva nota');
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const payload = mockInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.contenido).toBe('Nueva nota');
    expect(payload.autor_id).toBe('u1');
    expect(payload.miembro_id).toBe('m1');
    expect(mockOrder).toHaveBeenCalledTimes(2); // refetch
  });
});
