import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * Bloque A: el hook del historial de cambios respeta loading / error / data.
 */

const mockLimit = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: mockLimit
    }))
  }
}));

import { useAuditLogDeUsuario } from '../useAuditLogDeUsuario';

const ENTRADA = {
  id: 'a-1',
  accion: 'status_change',
  actor_rol: 'recepcionista',
  antes: { status: 'pendiente_pago' },
  despues: { status: 'activo' },
  motivo: 'Cliente activó/pagó plan',
  creada_at: '2026-06-11T10:00:00Z'
};

describe('useAuditLogDeUsuario', () => {
  beforeEach(() => {
    mockLimit.mockReset();
  });

  it('arranca en loading y luego entrega data', async () => {
    mockLimit.mockResolvedValue({ data: [ENTRADA], error: null });
    const { result } = renderHook(() => useAuditLogDeUsuario('m-1'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].accion).toBe('status_change');
  });

  it('marca error si la query falla', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { result } = renderHook(() => useAuditLogDeUsuario('m-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.entries).toHaveLength(0);
  });

  it('lista vacía cuando no hay cambios', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useAuditLogDeUsuario('m-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.entries).toHaveLength(0);
  });
});
