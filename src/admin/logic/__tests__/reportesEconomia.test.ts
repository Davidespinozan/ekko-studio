import { describe, it, expect } from 'vitest';
import { calcularEconomia, mensualizar, type TierLite } from '../reportesEconomia';

const BASICA: TierLite = { id: 't1', slug: 'basica', nombre: 'Básica', precio_centavos: 80000, periodo: 'mensual', moneda: 'MXN' };
const PRO: TierLite = { id: 't2', slug: 'pro', nombre: 'Pro', precio_centavos: 150000, periodo: 'mensual', moneda: 'MXN' };
const ANUAL: TierLite = { id: 't3', slug: 'anual', nombre: 'Anual', precio_centavos: 1200000, periodo: 'anual', moneda: 'MXN' };
const PAQUETE: TierLite = { id: 't4', slug: 'creador', nombre: 'Creador (5 sesiones)', precio_centavos: 250000, periodo: 'mensual', moneda: 'MXN', tipo: 'creditos' };
const HIBRIDO: TierLite = { id: 't5', slug: 'pro-pack', nombre: 'Pro pack', precio_centavos: 400000, periodo: 'mensual', moneda: 'MXN', tipo: 'hibrido' };

describe('mensualizar', () => {
  it('mensual → tal cual', () => {
    expect(mensualizar({ precio_centavos: 80000, periodo: 'mensual' })).toBe(80000);
  });
  it('anual → ÷ 12', () => {
    expect(mensualizar({ precio_centavos: 1200000, periodo: 'anual' })).toBe(100000);
  });
});

describe('calcularEconomia', () => {
  it('MRR = suma de precios mensuales de membresías facturables', () => {
    const r = calcularEconomia(
      [BASICA, PRO],
      [
        { tier_id: 't1', status: 'activa' },
        { tier_id: 't1', status: 'trialing' },
        { tier_id: 't2', status: 'past_due' }
      ],
      0
    );
    expect(r.mrrCentavos).toBe(80000 + 80000 + 150000); // 310000
    expect(r.arrCentavos).toBe(310000 * 12);
    expect(r.activosConPlan).toBe(3);
  });

  it('mensualiza los planes anuales en el MRR', () => {
    const r = calcularEconomia([ANUAL], [{ tier_id: 't3', status: 'activa' }], 0);
    expect(r.mrrCentavos).toBe(100000); // 1,200,000 / 12
  });

  it('ARPU = MRR ÷ miembros con plan', () => {
    const r = calcularEconomia([BASICA, PRO], [
      { tier_id: 't1', status: 'activa' },
      { tier_id: 't2', status: 'activa' }
    ], 0);
    expect(r.arpuCentavos).toBe(Math.round((80000 + 150000) / 2)); // 115000
  });

  it('ignora estados NO facturables (cancelada, pendiente, expirada)', () => {
    const r = calcularEconomia([BASICA], [
      { tier_id: 't1', status: 'activa' },
      { tier_id: 't1', status: 'cancelada' },
      { tier_id: 't1', status: 'pendiente' },
      { tier_id: 't1', status: 'expirada' }
    ], 0);
    expect(r.activosConPlan).toBe(1);
    expect(r.mrrCentavos).toBe(80000);
  });

  it('ignora membresías cuyo tier no existe (sin romper)', () => {
    const r = calcularEconomia([BASICA], [{ tier_id: 'fantasma', status: 'activa' }], 0);
    expect(r.mrrCentavos).toBe(0);
    expect(r.activosConPlan).toBe(0);
  });

  it('churn: bajas 90d ÷ 3 ÷ activos × 100', () => {
    // 6 bajas en 90d, 100 activos → (6/3/100)*100 = 2% mensual
    const membresias = Array.from({ length: 100 }, () => ({ tier_id: 't1', status: 'activa' }));
    const r = calcularEconomia([BASICA], membresias, 6);
    expect(r.churnMensualPct).toBeCloseTo(2, 5);
    // vida media = 100/2 = 50 → topada a 36
    expect(r.vidaMediaMeses).toBe(36);
    expect(r.ltvCentavos).toBe(Math.round(80000 * 36));
  });

  it('sin activos → churn/vida/ltv null (no divide por cero)', () => {
    const r = calcularEconomia([BASICA], [], 5);
    expect(r.churnMensualPct).toBeNull();
    expect(r.vidaMediaMeses).toBeNull();
    expect(r.ltvCentavos).toBeNull();
    expect(r.arpuCentavos).toBe(0);
  });

  it('churn = 0 → vida media y LTV indeterminados (null)', () => {
    const r = calcularEconomia([BASICA], [{ tier_id: 't1', status: 'activa' }], 0);
    expect(r.churnMensualPct).toBe(0);
    expect(r.vidaMediaMeses).toBeNull();
    expect(r.ltvCentavos).toBeNull();
  });

  it('ingresoPorPlan desglosa MRR por tier, ordenado desc', () => {
    const r = calcularEconomia([BASICA, PRO], [
      { tier_id: 't1', status: 'activa' },
      { tier_id: 't2', status: 'activa' },
      { tier_id: 't2', status: 'activa' }
    ], 0);
    expect(r.ingresoPorPlan).toEqual([
      { slug: 'pro', nombre: 'Pro', mrrCentavos: 300000, miembros: 2 },
      { slug: 'basica', nombre: 'Básica', mrrCentavos: 80000, miembros: 1 }
    ]);
  });

  it('los paquetes de créditos (creditos/hibrido) NO entran al MRR ni al ARPU; se cuentan aparte', () => {
    const r = calcularEconomia([BASICA, PAQUETE, HIBRIDO], [
      { tier_id: 't1', status: 'activa' },
      { tier_id: 't4', status: 'activa' },
      { tier_id: 't5', status: 'activa' }
    ], 0);
    expect(r.mrrCentavos).toBe(80000);
    expect(r.arrCentavos).toBe(80000 * 12);
    expect(r.activosConPlan).toBe(1);
    expect(r.arpuCentavos).toBe(80000);
    expect(r.paquetesActivos).toBe(2);
    expect(r.ingresoPorPlan.map((p) => p.slug)).toEqual(['basica']);
  });

  it('tier sin `tipo` (filas viejas) se trata como recurrente', () => {
    const r = calcularEconomia([{ ...BASICA, tipo: undefined }], [{ tier_id: 't1', status: 'activa' }], 0);
    expect(r.mrrCentavos).toBe(80000);
    expect(r.paquetesActivos).toBe(0);
  });
});
