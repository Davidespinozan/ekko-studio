import { describe, it, expect } from 'vitest';
import { calcularCreditos, type MovimientoLite, type SaldoLite } from '../reportesCreditos';

describe('reportesCreditos', () => {
  it('sin datos → todo en cero, tasa null', () => {
    const r = calcularCreditos([], []);
    expect(r).toEqual({
      pasivoSesiones: 0,
      valorPasivoCentavos: 0,
      miembrosConSaldo: 0,
      vendidos: 0,
      usados: 0,
      tasaUsoPct: null
    });
  });

  it('vendidos = altas; usados = débitos + no-shows', () => {
    const movs: MovimientoLite[] = [
      { tipo: 'alta', delta: 10 },
      { tipo: 'alta', delta: 6 },
      { tipo: 'debito', delta: -1 },
      { tipo: 'debito', delta: -1 },
      { tipo: 'no_show', delta: -1 },
      { tipo: 'devolucion', delta: 1 }, // no cuenta como uso ni venta
      { tipo: 'ajuste', delta: 2 } // no cuenta como venta
    ];
    const r = calcularCreditos(movs, []);
    expect(r.vendidos).toBe(16);
    expect(r.usados).toBe(3);
    expect(r.tasaUsoPct).toBeCloseTo((3 / 16) * 100);
  });

  it('pasivo = saldo vivo; valora con precio por crédito del plan', () => {
    const saldos: SaldoLite[] = [
      { creditos_restantes: 4, precio_centavos: 120000, clases_incluidas: 6 }, // 20000/crédito → 80000
      { creditos_restantes: 2, precio_centavos: 65000, clases_incluidas: 3 }, // ~21667/crédito → 43333
      { creditos_restantes: 0, precio_centavos: 65000, clases_incluidas: 3 }, // saldo 0 → ignora
      { creditos_restantes: null, precio_centavos: 80000, clases_incluidas: null } // plan por tiempo → ignora
    ];
    const r = calcularCreditos([], saldos);
    expect(r.pasivoSesiones).toBe(6);
    expect(r.miembrosConSaldo).toBe(2);
    expect(r.valorPasivoCentavos).toBe(80000 + Math.round(2 * (65000 / 3)));
  });

  it('saldo sin precio/cupo del plan → suma sesiones pero no valor', () => {
    const r = calcularCreditos([], [
      { creditos_restantes: 5, precio_centavos: null, clases_incluidas: null },
      { creditos_restantes: 3, precio_centavos: 90000, clases_incluidas: 0 } // cupo 0 → sin valor
    ]);
    expect(r.pasivoSesiones).toBe(8);
    expect(r.valorPasivoCentavos).toBe(0);
  });
});
