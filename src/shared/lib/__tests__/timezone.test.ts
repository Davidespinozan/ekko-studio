import { describe, it, expect } from 'vitest';
import {
  ZONA_ESTUDIO,
  partesEnZona,
  instanteEnZona,
  inicioDeHoyEnZona,
  inicioDeMesEnZona
} from '../timezone';

// America/Mazatlan = UTC-7 fijo (Culiacán, sin horario de verano).

describe('partesEnZona', () => {
  it('convierte un instante UTC a la hora de pared de Mazatlan', () => {
    // 02:00 UTC del 1 de julio → 19:00 del 30 de junio en Mazatlan (UTC-7).
    const p = partesEnZona(new Date('2026-07-01T02:00:00Z'));
    expect(p).toMatchObject({ year: 2026, month: 6, day: 30, hour: 19 });
  });

  it('mediodía UTC cae el mismo día', () => {
    const p = partesEnZona(new Date('2026-07-01T12:00:00Z'));
    expect(p).toMatchObject({ year: 2026, month: 7, day: 1, hour: 5 }); // 12-7
  });

  it('dow: 0=domingo … 6=sábado', () => {
    // 2026-07-01 es miércoles.
    expect(partesEnZona(new Date('2026-07-01T18:00:00Z')).dow).toBe(3);
  });
});

describe('instanteEnZona', () => {
  it('medianoche de pared en Mazatlan = 07:00 UTC', () => {
    expect(instanteEnZona(2026, 6, 1).toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });
});

describe('inicioDeHoyEnZona', () => {
  it('da la medianoche local del día en curso (no del navegador)', () => {
    // "Ahora" = 2026-07-02 01:00 UTC → en Mazatlan sigue siendo 1 de julio 18:00.
    // El inicio de hoy debe ser 1 jul 00:00 Mazatlan = 07:00 UTC del 1.
    const hoy = inicioDeHoyEnZona(new Date('2026-07-02T01:00:00Z'));
    expect(hoy.toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });
});

describe('inicioDeMesEnZona', () => {
  it('mes actual: día 1 00:00 en la zona', () => {
    const m = inicioDeMesEnZona(0, new Date('2026-07-15T12:00:00Z'));
    expect(m.toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('mes anterior', () => {
    const m = inicioDeMesEnZona(-1, new Date('2026-07-15T12:00:00Z'));
    expect(m.toISOString()).toBe('2026-06-01T07:00:00.000Z');
  });

  it('cruce de año: enero → diciembre anterior', () => {
    const m = inicioDeMesEnZona(-1, new Date('2026-01-10T12:00:00Z'));
    expect(m.toISOString()).toBe('2025-12-01T07:00:00.000Z');
  });

  it('borde de mes: 1 jul 02:00 UTC todavía es junio en Mazatlan', () => {
    // Ese instante en Mazatlan es 30 jun 19:00 → "mes actual" = junio.
    const m = inicioDeMesEnZona(0, new Date('2026-07-01T02:00:00Z'));
    expect(m.toISOString()).toBe('2026-06-01T07:00:00.000Z');
  });

  it('la zona del estudio es America/Mazatlan', () => {
    expect(ZONA_ESTUDIO).toBe('America/Mazatlan');
  });
});
