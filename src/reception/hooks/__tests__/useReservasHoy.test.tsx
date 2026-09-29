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

// ── PKG-02A (C02 · F02) · error ≠ "sin reservas"; polling fallido = stale ─────
import { estadoListaHoy } from '../useReservasHoy';

describe('useReservasHoy · estados honestos (PKG-02A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockOrder.mockReset();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('primer fetch falla → error=true, cargado=false, lista vacía (la vista pinta error, no "Sin reservas")', async () => {
    mockOrder.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const { result } = renderHook(() => useReservasHoy('2026-09-28'));
    await flush();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe(true);
    expect(result.current.cargado).toBe(false);
    expect(result.current.reservas).toEqual([]);
    expect(estadoListaHoy(result.current)).toBe('error');
  });

  it('success con [] → error=false, cargado=true (vacío legítimo)', async () => {
    mockOrder.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useReservasHoy('2026-09-28'));
    await flush();
    expect(result.current.error).toBe(false);
    expect(result.current.cargado).toBe(true);
    expect(estadoListaHoy(result.current)).toBe('ok');
  });

  it('lista previa válida + refetch fallido → CONSERVA la lista y marca stale', async () => {
    mockOrder.mockResolvedValue({ data: [{ id: 'r1', status: 'confirmada' }], error: null });
    const { result } = renderHook(() => useReservasHoy('2026-09-28'));
    await flush();
    expect(result.current.reservas).toHaveLength(1);

    mockOrder.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(true);
    expect(result.current.reservas).toHaveLength(1); // no se vació
    expect(estadoListaHoy(result.current)).toBe('stale');

    mockOrder.mockResolvedValue({ data: [{ id: 'r1' }, { id: 'r2' }], error: null });
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe(false);
    expect(result.current.reservas).toHaveLength(2);
    expect(estadoListaHoy(result.current)).toBe('ok');
  });

  it('estadoListaHoy: cargando solo mientras no hay dato ni error', () => {
    expect(estadoListaHoy({ isLoading: true, error: false, cargado: false })).toBe('cargando');
    expect(estadoListaHoy({ isLoading: true, error: false, cargado: true })).toBe('ok'); // refetch en curso con dato: no skeleton
    expect(estadoListaHoy({ isLoading: false, error: true, cargado: false })).toBe('error');
    expect(estadoListaHoy({ isLoading: false, error: true, cargado: true })).toBe('stale');
    expect(estadoListaHoy({ isLoading: false, error: false, cargado: true })).toBe('ok');
  });
});
