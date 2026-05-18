import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { puedeCancelarReserva } from '../useReglaCancelacion';

describe('puedeCancelarReserva', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rechaza reserva pasada', () => {
    const ayer = new Date('2026-05-17T12:00:00Z');
    const r = puedeCancelarReserva(ayer, 0);
    expect(r.puede).toBe(false);
    expect(r.razon).toBe('Esta reserva ya pasó');
  });

  it('rechaza reserva en el instante actual', () => {
    const r = puedeCancelarReserva(new Date('2026-05-18T12:00:00Z'), 0);
    expect(r.puede).toBe(false);
  });

  it('permite con regla 0 (permisivo) hasta minutos antes', () => {
    const en30min = new Date('2026-05-18T12:30:00Z');
    const r = puedeCancelarReserva(en30min, 0);
    expect(r.puede).toBe(true);
  });

  it('rechaza si faltan menos horas que la regla', () => {
    const en2h = new Date('2026-05-18T14:00:00Z');
    const r = puedeCancelarReserva(en2h, 6);
    expect(r.puede).toBe(false);
    expect(r.razon).toContain('6 horas');
  });

  it('permite si faltan exactamente las horas de la regla', () => {
    const en6h = new Date('2026-05-18T18:00:00Z');
    const r = puedeCancelarReserva(en6h, 6);
    expect(r.puede).toBe(true);
  });

  it('permite si faltan más horas que la regla', () => {
    const enDosDias = new Date('2026-05-20T12:00:00Z');
    const r = puedeCancelarReserva(enDosDias, 24);
    expect(r.puede).toBe(true);
    expect(r.horasRestantes).toBeCloseTo(48, 0);
  });

  it('acepta string ISO como input', () => {
    const r = puedeCancelarReserva('2026-05-19T12:00:00Z', 0);
    expect(r.puede).toBe(true);
    expect(r.horasRestantes).toBeCloseTo(24, 0);
  });
});
