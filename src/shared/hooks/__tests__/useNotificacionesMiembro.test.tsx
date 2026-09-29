import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockLimit = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: mockLimit,
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    }))
  }
}));

const { MOCK_USUARIO } = vi.hoisted(() => ({
  MOCK_USUARIO: { id: 'user-1', tenant_id: 't1' }
}));
vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ usuario: MOCK_USUARIO })
}));

import { useNotificacionesMiembro } from '../useNotificacionesMiembro';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useNotificacionesMiembro · visibility-aware polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLimit.mockReset();
    mockLimit.mockResolvedValue({ data: [], error: null });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetch inicial al montar (visible)', async () => {
    renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it('hace polling cada 30s mientras tab visible', async () => {
    renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(mockLimit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockLimit).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockLimit).toHaveBeenCalledTimes(3);
  });

  it('pausa polling cuando tab se vuelve inactiva', async () => {
    renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(mockLimit).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it('refetch inmediato + reanuda polling al volver a la tab', async () => {
    renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(mockLimit).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockLimit).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
    });
    await flushPromises();
    expect(mockLimit).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockLimit).toHaveBeenCalledTimes(3);
  });
});

// ── PKG-02A (C02 · F21) · error ≠ "estás al día"; polling fallido = stale ─────
describe('useNotificacionesMiembro · estados honestos (PKG-02A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockLimit.mockReset();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('primer fetch falla → error=true, cargado=false, lista vacía', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const { result } = renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(result.current.error).toBe(true);
    expect(result.current.cargado).toBe(false);
    expect(result.current.notificaciones).toEqual([]);
  });

  it('success con [] → cargado=true, error=false (vacío real)', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(result.current.error).toBe(false);
    expect(result.current.cargado).toBe(true);
  });

  it('avisos previos + refetch fallido → se CONSERVAN y error=true; el siguiente éxito lo limpia', async () => {
    mockLimit.mockResolvedValue({ data: [{ id: 'n1', tipo: 'x', titulo: 'T', mensaje: 'M', metadata: null, creada_at: '2026-01-01', leida: false }], error: null });
    const { result } = renderHook(() => useNotificacionesMiembro());
    await flushPromises();
    expect(result.current.notificaciones).toHaveLength(1);
    mockLimit.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(true);
    expect(result.current.cargado).toBe(true);
    expect(result.current.notificaciones).toHaveLength(1);
    mockLimit.mockResolvedValue({ data: [], error: null });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.notificaciones).toHaveLength(0);
  });
});
