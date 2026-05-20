import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisibilityAwarePolling } from '../useVisibilityAwarePolling';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useVisibilityAwarePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ejecuta poll inmediatamente al montar', () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePolling(poll, 30_000));
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('hace polling cada intervalMs mientras la tab está visible', async () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePolling(poll, 30_000));
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(poll).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('pausa el polling cuando la tab se oculta', async () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePolling(poll, 30_000));
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('refetch inmediato + reanuda al volver a la tab', async () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePolling(poll, 30_000));
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    act(() => {
      setVisibility('visible');
    });
    expect(poll).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('enabled=false desactiva todo (no fetch, no polling)', async () => {
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePolling(poll, 30_000, false));
    expect(poll).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(poll).not.toHaveBeenCalled();
  });

  it('no monta el interval si la tab arranca oculta', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true, configurable: true });
    const poll = vi.fn();
    renderHook(() => useVisibilityAwarePolling(poll, 30_000));
    // poll inicial corre igual (1 vez), pero sin interval activo
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
