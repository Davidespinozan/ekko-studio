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

// ── Fechas de calendario del estudio ────────────────────────────────────────
import {
  fechaISOEnZona,
  sumarDiasISO,
  diasEntreISO,
  diaSemanaDeFechaISO,
  instanteDeFechaHoraEnZona,
  rangoDiaEnZona,
  formatHoraEnZona
} from '../timezone';

describe('fechaISOEnZona', () => {
  it('02:00 UTC del 1 de julio sigue siendo 30 de junio en Mazatlan', () => {
    expect(fechaISOEnZona(new Date('2026-07-01T02:00:00Z'))).toBe('2026-06-30');
    expect(fechaISOEnZona('2026-07-01T12:00:00Z')).toBe('2026-07-01');
  });
});

describe('aritmética de fechas ISO', () => {
  it('sumarDiasISO cruza mes y año', () => {
    expect(sumarDiasISO('2026-07-31', 1)).toBe('2026-08-01');
    expect(sumarDiasISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDiasISO('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('diasEntreISO', () => {
    expect(diasEntreISO('2026-07-01', '2026-07-03')).toBe(2);
    expect(diasEntreISO('2026-07-03', '2026-07-01')).toBe(-2);
  });
  it('diaSemanaDeFechaISO: 2026-07-01 es miércoles (3), sin depender del navegador', () => {
    expect(diaSemanaDeFechaISO('2026-07-01')).toBe(3);
    expect(diaSemanaDeFechaISO('2026-07-05')).toBe(0);
  });
});

describe('instanteDeFechaHoraEnZona / rangoDiaEnZona', () => {
  it('10:00 de pared en Mazatlan = 17:00 UTC', () => {
    expect(instanteDeFechaHoraEnZona('2026-07-01', '10:00').toISOString()).toBe('2026-07-01T17:00:00.000Z');
  });
  it('el rango del día va de 07:00Z a 07:00Z del día siguiente', () => {
    const { inicio, fin } = rangoDiaEnZona('2026-07-01');
    expect(inicio.toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(fin.toISOString()).toBe('2026-07-02T07:00:00.000Z');
  });
});

describe('formatHoraEnZona', () => {
  it('muestra la hora de pared del estudio en 24 h', () => {
    expect(formatHoraEnZona('2026-07-01T17:05:00Z')).toBe('10:05');
    expect(formatHoraEnZona('2026-07-01T07:00:00Z')).toBe('00:00');
  });
});
