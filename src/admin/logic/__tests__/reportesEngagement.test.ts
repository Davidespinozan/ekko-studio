import { describe, it, expect } from 'vitest';
import { calcularEngagement, type MiembroLite, type ReservaEngLite } from '../reportesEngagement';

const AHORA = new Date('2026-07-01T12:00:00Z').getTime();
const hace = (dias: number) => new Date(AHORA - dias * 24 * 60 * 60 * 1000).toISOString();

const miembro = (id: string, over: Partial<MiembroLite> = {}): MiembroLite => ({
  id,
  nombre: `M${id}`,
  email: `${id}@ekko.mx`,
  telefono: null,
  created_at: hace(200),
  ...over
});

describe('calcularEngagement', () => {
  it('MAU y % que vienen: activos con sesión en 30d', () => {
    const activos = [miembro('a'), miembro('b'), miembro('c'), miembro('d')];
    const reservas: ReservaEngLite[] = [
      { usuario_id: 'a', slot_inicio: hace(5), status: 'completada', created_at: hace(10) },
      { usuario_id: 'b', slot_inicio: hace(10), status: 'confirmada', created_at: hace(12) },
      // c vino hace 40d (fuera de 30d) → no MAU
      { usuario_id: 'c', slot_inicio: hace(40), status: 'completada', created_at: hace(45) }
      // d nunca
    ];
    const r = calcularEngagement(activos, reservas, [], AHORA);
    expect(r.mau).toBe(2); // a, b
    expect(r.activos).toBe(4);
    expect(r.porcentajeVienen).toBeCloseTo(50, 5);
  });

  it('activación: nuevos que hicieron su 1ª reserva ÷ cohorte', () => {
    const nuevos = [miembro('n1', { created_at: hace(20) }), miembro('n2', { created_at: hace(20) }), miembro('n3', { created_at: hace(20) })];
    const activos = [...nuevos];
    const reservas: ReservaEngLite[] = [
      { usuario_id: 'n1', slot_inicio: hace(5), status: 'confirmada', created_at: hace(18) },
      { usuario_id: 'n2', slot_inicio: hace(3), status: 'completada', created_at: hace(15) }
      // n3 nunca reservó
    ];
    const r = calcularEngagement(activos, reservas, nuevos, AHORA);
    expect(r.cohorteNuevos).toBe(3);
    expect(r.activacionPct).toBeCloseTo((2 / 3) * 100, 5);
  });

  it('TTV: días promedio del alta a la 1ª reserva', () => {
    const nuevos = [miembro('n1', { created_at: hace(20) })];
    const reservas: ReservaEngLite[] = [
      { usuario_id: 'n1', slot_inicio: hace(5), status: 'confirmada', created_at: hace(18) }, // 2 días tras alta
      { usuario_id: 'n1', slot_inicio: hace(2), status: 'confirmada', created_at: hace(10) } // posterior, no cuenta
    ];
    const r = calcularEngagement(nuevos, reservas, nuevos, AHORA);
    expect(r.ttvDias).toBeCloseTo(2, 1);
  });

  it('miembros en riesgo: activos sin venir en 21d, urgentes primero', () => {
    const activos = [
      miembro('sano', { nombre: 'Sano' }),
      miembro('riesgo', { nombre: 'Riesgo' }),
      miembro('nunca', { nombre: 'Nunca' })
    ];
    const reservas: ReservaEngLite[] = [
      { usuario_id: 'sano', slot_inicio: hace(3), status: 'completada', created_at: hace(10) },
      { usuario_id: 'riesgo', slot_inicio: hace(40), status: 'completada', created_at: hace(50) }
      // nunca: sin reservas
    ];
    const r = calcularEngagement(activos, reservas, [], AHORA);
    const ids = r.enRiesgo.map((m) => m.id);
    expect(ids).not.toContain('sano');
    expect(ids).toContain('riesgo');
    expect(ids).toContain('nunca');
    // El que nunca vino va primero (más urgente).
    expect(r.enRiesgo[0].id).toBe('nunca');
    expect(r.enRiesgo[0].diasSinVenir).toBeNull();
    const riesgo = r.enRiesgo.find((m) => m.id === 'riesgo')!;
    expect(riesgo.diasSinVenir).toBe(40);
  });

  it('canceladas/no_show no cuentan como "vino"', () => {
    const activos = [miembro('a')];
    const reservas: ReservaEngLite[] = [
      { usuario_id: 'a', slot_inicio: hace(2), status: 'no_show', created_at: hace(5) },
      { usuario_id: 'a', slot_inicio: hace(1), status: 'cancelada', created_at: hace(4) }
    ];
    const r = calcularEngagement(activos, reservas, [], AHORA);
    expect(r.mau).toBe(0);
    expect(r.enRiesgo[0].id).toBe('a'); // no asistió → en riesgo (nunca vino)
    expect(r.enRiesgo[0].diasSinVenir).toBeNull();
  });

  it('sin activos → porcentajes null, sin dividir por cero', () => {
    const r = calcularEngagement([], [], [], AHORA);
    expect(r.porcentajeVienen).toBeNull();
    expect(r.activacionPct).toBeNull();
    expect(r.ttvDias).toBeNull();
    expect(r.enRiesgo).toEqual([]);
  });
});
