import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockOrder = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      order: mockOrder
    }))
  }
}));

vi.mock('@shared/hooks/useTenant', () => ({
  useTenant: () => ({ id: 'tenant-1' })
}));

import { useReservasHoy } from '../useReservasHoy';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useReservasHoy · visibility-aware polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockOrder.mockReset();
    mockOrder.mockResolvedValue({ data: [], error: null });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetch inicial al montar', async () => {
    renderHook(() => useReservasHoy());
    await flush();
    expect(mockOrder).toHaveBeenCalledTimes(1);
  });

  it('pollingEnabled=false no hace fetch ni arranca el interval', async () => {
    renderHook(() => useReservasHoy(undefined, false));
    await flush();
    expect(mockOrder).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mockOrder).not.toHaveBeenCalled();
  });

  it('reanuda fetch + polling cuando pollingEnabled pasa de false a true', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useReservasHoy(undefined, enabled),
      { initialProps: { enabled: false } }
    );
    await flush();
    expect(mockOrder).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await flush();
    expect(mockOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockOrder).toHaveBeenCalledTimes(2);
  });

  it('polling cada 30s mientras la tab está visible', async () => {
    renderHook(() => useReservasHoy());
    await flush();
    expect(mockOrder).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockOrder).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockOrder).toHaveBeenCalledTimes(3);
  });

  it('pausa el polling cuando la tab se oculta', async () => {
    renderHook(() => useReservasHoy());
    await flush();
    expect(mockOrder).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mockOrder).toHaveBeenCalledTimes(1);
  });

  it('refetch inmediato + reanuda polling al volver a la tab', async () => {
    renderHook(() => useReservasHoy());
    await flush();
    expect(mockOrder).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockOrder).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
    });
    await flush();
    expect(mockOrder).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockOrder).toHaveBeenCalledTimes(3);
  });
});
