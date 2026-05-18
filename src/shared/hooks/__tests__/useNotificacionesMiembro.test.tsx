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
