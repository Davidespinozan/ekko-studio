import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { celebrar } from '../celebrar';

describe('celebrar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('inyecta una capa con la cantidad pedida de piezas', () => {
    celebrar(10);
    const layer = document.querySelector('.ek-confetti-layer');
    expect(layer).not.toBeNull();
    expect(layer!.querySelectorAll('.ek-confetti-piece')).toHaveLength(10);
  });

  it('se autolimpia tras el timeout', () => {
    celebrar(5);
    expect(document.querySelector('.ek-confetti-layer')).not.toBeNull();
    vi.advanceTimersByTime(2600);
    expect(document.querySelector('.ek-confetti-layer')).toBeNull();
  });

  it('respeta prefers-reduced-motion (no inyecta nada)', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList);
    celebrar(20);
    expect(document.querySelector('.ek-confetti-layer')).toBeNull();
  });
});
