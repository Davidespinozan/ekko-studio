import { describe, it, expect } from 'vitest';
import { generarResumen } from '../reportesResumen';
import type { EconomiaResult } from '../reportesEconomia';
import type { OcupacionResult } from '../reportesOcupacion';
import type { EngagementResult } from '../reportesEngagement';
import type { CreditosResult } from '../reportesCreditos';

const eco = (o: Partial<EconomiaResult> = {}): EconomiaResult => ({
  mrrCentavos: 500000, arrCentavos: 6000000, arpuCentavos: 50000, activosConPlan: 10,
  churnMensualPct: 3, vidaMediaMeses: 30, ltvCentavos: 1500000, moneda: 'mxn', ingresoPorPlan: [], paquetesActivos: 0, ...o
});
const ocu = (o: Partial<OcupacionResult> = {}): OcupacionResult => ({
  dias: 90, ocupacionPct: 70, asistenciaPct: 95, totalReservas: 100, horasReservadas: 100,
  noShows: 0, porEstudio: [], heatmap: [], heatmapMax: 0, ...o
});
const eng = (o: Partial<EngagementResult> = {}): EngagementResult => ({
  activos: 10, mau: 8, porcentajeVienen: 80, activacionPct: 80, cohorteNuevos: 5, ttvDias: 2, enRiesgo: [], ...o
});
const cre = (o: Partial<CreditosResult> = {}): CreditosResult => ({
  pasivoSesiones: 10, valorPasivoCentavos: 200000, miembrosConSaldo: 3, vendidos: 100, usados: 90, tasaUsoPct: 90, ...o
});

describe('reportesResumen', () => {
  it('sin datos → resumen vacío (el componente muestra placeholder)', () => {
    expect(generarResumen(null, null, null, null)).toEqual([]);
  });

  it('todo sano con actividad → insight positivo', () => {
    const r = generarResumen(eco(), ocu(), eng(), cre());
    expect(r).toHaveLength(1);
    expect(r[0].tono).toBe('good');
    expect(r[0].texto).toMatch(/ocupación sana/i);
  });

  it('sin focos y sin ocupación medible pero con actividad → cierre positivo', () => {
    const r = generarResumen(eco(), ocu({ ocupacionPct: null }), eng(), cre());
    expect(r).toHaveLength(1);
    expect(r[0].tono).toBe('good');
    expect(r[0].texto).toMatch(/sin focos rojos/i);
  });

  it('ocupación baja y churn alto → focos rojos ordenados primero', () => {
    const r = generarResumen(eco({ churnMensualPct: 15 }), ocu({ ocupacionPct: 20 }), eng(), cre());
    expect(r.filter((x) => x.tono === 'bad').length).toBeGreaterThanOrEqual(2);
    expect(r[0].tono).toBe('bad'); // los rojos van arriba
    expect(r.some((x) => /ocupación baja/i.test(x.texto))).toBe(true);
    expect(r.some((x) => /churn alto/i.test(x.texto))).toBe(true);
  });

  it('miembros en riesgo: 1-2 es ámbar, 3+ es rojo', () => {
    const risk = (n: number) => Array.from({ length: n }, () => ({}) as never);
    expect(generarResumen(eco(), ocu(), eng({ enRiesgo: risk(2) }), cre()).find((x) => /riesgo de baja/i.test(x.texto))?.tono).toBe('warn');
    expect(generarResumen(eco(), ocu(), eng({ enRiesgo: risk(4) }), cre()).find((x) => /riesgo de baja/i.test(x.texto))?.tono).toBe('bad');
  });

  it('créditos poco usados → avisa el pasivo con valor', () => {
    const r = generarResumen(eco(), ocu(), eng(), cre({ tasaUsoPct: 30, vendidos: 100, usados: 30, valorPasivoCentavos: 700000 }));
    const it = r.find((x) => /créditos vendidos se han usado/i.test(x.texto));
    expect(it).toBeTruthy();
    expect(it?.tono).toBe('bad'); // <35% es rojo
    expect(it?.texto).toMatch(/\$7,000/); // valor del pasivo formateado
  });

  it('tope de 5 insights', () => {
    const r = generarResumen(
      eco({ churnMensualPct: 20 }),
      ocu({ ocupacionPct: 15, asistenciaPct: 60, noShows: 5 }),
      eng({ enRiesgo: [{}, {}, {}] as never, activacionPct: 20, cohorteNuevos: 5, porcentajeVienen: 20, activos: 10 }),
      cre({ tasaUsoPct: 20, vendidos: 100, usados: 20 })
    );
    expect(r.length).toBeLessThanOrEqual(5);
  });
});
