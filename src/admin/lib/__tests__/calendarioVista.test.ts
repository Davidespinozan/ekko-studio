import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readVista, VISTA_STORAGE_KEY } from '../calendarioVista';

function setViewportWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { value: px, writable: true, configurable: true });
}

describe('readVista', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('respeta preferencia guardada — dia', () => {
    localStorage.setItem(VISTA_STORAGE_KEY, 'dia');
    setViewportWidth(1280);
    expect(readVista()).toBe('dia');
  });

  it('respeta preferencia guardada — semana', () => {
    localStorage.setItem(VISTA_STORAGE_KEY, 'semana');
    setViewportWidth(375);
    expect(readVista()).toBe('semana');
  });

  it('respeta preferencia guardada — lista', () => {
    localStorage.setItem(VISTA_STORAGE_KEY, 'lista');
    setViewportWidth(375);
    expect(readVista()).toBe('lista');
  });

  it('sin preferencia: default dia en mobile (<768px)', () => {
    setViewportWidth(375);
    expect(readVista()).toBe('dia');
  });

  it('sin preferencia: default semana en desktop (≥768px)', () => {
    setViewportWidth(1024);
    expect(readVista()).toBe('semana');
  });

  it('breakpoint exacto 768px cuenta como desktop', () => {
    setViewportWidth(768);
    expect(readVista()).toBe('semana');
  });

  it('valor legacy "calendario" se ignora y cae al default por viewport', () => {
    localStorage.setItem(VISTA_STORAGE_KEY, 'calendario');
    setViewportWidth(375);
    expect(readVista()).toBe('dia');
  });

  it('valor corrupto en localStorage cae al default por viewport', () => {
    localStorage.setItem(VISTA_STORAGE_KEY, 'xyz');
    setViewportWidth(1280);
    expect(readVista()).toBe('semana');
  });
});
