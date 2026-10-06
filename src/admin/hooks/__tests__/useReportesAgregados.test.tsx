import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * PKG-06F (FR-62/63) · los reportes de admin consumen los AGREGADOS del servidor:
 * no traen filas crudas para sumarlas, un fallo es error (nunca "cero") y el
 * resultado coincide con la lógica pura de siempre.
 */

const h = vi.hoisted(() => ({
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  llamadas: [] as Array<{ fn: string; args?: Record<string, unknown> }>,
  from: vi.fn()
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      h.llamadas.push({ fn, args });
      return Promise.resolve(h.rpc[fn] ?? { data: null, error: { message: `rpc inesperado ${fn}` } });
    },
    from: (tabla: string) => {
      h.from(tabla);
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order']) c[m] = () => c;
      c.then = (cb: (v: unknown) => unknown) =>
        Promise.resolve(tabla === 'tiers'
          ? { data: [{ id: 'tr', slug: 'esencial', nombre: 'Esencial', precio_centavos: 85000, periodo: 'mensual', moneda: 'MXN', tipo: 'tiempo' }], error: null }
          : { data: null, count: 3, error: null }).then(cb);
      return c;
    }
  }
}));

import { useReportesCreditos } from '../useReportesCreditos';
import { useReportesCobrado } from '../useReportesCobrado';
import { useReportesEconomia } from '../useReportesEconomia';
import { useDineroMetrics } from '../useAdminData';

beforeEach(() => {
  vi.clearAllMocks();
  h.rpc = {};
  h.llamadas.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useReportesCreditos', () => {
  it('31/34/14 · éxito: un solo RPC (sin leer el ledger crudo) y el resultado de siempre', async () => {
    h.rpc.reporte_creditos = { data: [{ vendidos: 3000, usados: 1500, pasivo_sesiones: 40, valor_pasivo_centavos: 123456, miembros_con_saldo: 7 }], error: null };
    const { result } = renderHook(() => useReportesCreditos());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.data).toEqual({ pasivoSesiones: 40, valorPasivoCentavos: 123456, miembrosConSaldo: 7, vendidos: 3000, usados: 1500, tasaUsoPct: 50 });
    expect(h.from).not.toHaveBeenCalled();
    expect(h.llamadas.map((l) => l.fn)).toEqual(['reporte_creditos']);
  });

  it('13/33 · el RPC falla → error=true y data null (nunca un pasivo en cero)', async () => {
    h.rpc.reporte_creditos = { data: null, error: { message: 'EKKO_NO_AUTORIZADO: Solo un admin' } };
    const { result } = renderHook(() => useReportesCreditos());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('32 · estudio vacío → ceros reales y tasa null (no error)', async () => {
    h.rpc.reporte_creditos = { data: [{ vendidos: 0, usados: 0, pasivo_sesiones: 0, valor_pasivo_centavos: 0, miembros_con_saldo: 0 }], error: null };
    const { result } = renderHook(() => useReportesCreditos());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.tasaUsoPct).toBeNull();
    expect(result.current.error).toBe(false);
  });
});

describe('useReportesCobrado / useDineroMetrics', () => {
  const grupos = [
    { periodo: 'mes', clase: 'cobro', origen_negocio: 'paquete', moneda: 'mxn', estado_evidencia: 'firme', monto_centavos: 2500000, efecto_neto_centavos: 2500000, n: 1800 },
    { periodo: 'mes_anterior', clase: 'cobro', origen_negocio: 'suscripcion_renovacion', moneda: 'mxn', estado_evidencia: 'firme', monto_centavos: 900000, efecto_neto_centavos: 900000, n: 12 }
  ];

  it('34 · lo cobrado sale de los grupos y los fallidos de su resumen; ningún SELECT crudo', async () => {
    h.rpc.libro_economico_agregado = { data: grupos, error: null };
    h.rpc.cobros_fallidos_resumen = { data: [{ cobros: 1300, monto_centavos: 6500000 }], error: null };
    const { result } = renderHook(() => useReportesCobrado());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toMatchObject({ cobradoMesCentavos: 2500000, cobradoMesAnteriorCentavos: 900000, cobrosFallidos30d: 1300, montoFallido30dCentavos: 6500000 });
    expect(result.current.data?.porConcepto).toEqual([{ concepto: 'Paquetes', centavos: 2500000, cobros: 1800 }]);
    expect(h.from).not.toHaveBeenCalled();
    const args = h.llamadas.find((l) => l.fn === 'libro_economico_agregado')!.args!;
    expect(Object.keys(args).sort()).toEqual(['p_desde', 'p_hasta', 'p_inicio_mes', 'p_inicio_mes_anterior']);
  });

  it('13 · falla el resumen de fallidos → error, no "0 fallidos"', async () => {
    h.rpc.libro_economico_agregado = { data: grupos, error: null };
    h.rpc.cobros_fallidos_resumen = { data: null, error: { message: 'x' } };
    const { result } = renderHook(() => useReportesCobrado());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('dashboard: facturado del mes y del anterior y número de cobros desde los grupos (1,800 cobros)', async () => {
    h.rpc.libro_economico_agregado = { data: grupos, error: null };
    const { result } = renderHook(() => useDineroMetrics());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.metrics).toEqual({ facturadoMesActual: 2500000, facturadoMesAnterior: 900000, cobrosMesActual: 1800 });
    h.rpc.libro_economico_agregado = { data: null, error: { message: 'x' } };
    const r2 = renderHook(() => useDineroMetrics());
    await waitFor(() => expect(r2.result.current.isLoading).toBe(false));
    expect(r2.result.current.error).toBe(true);
    expect(r2.result.current.metrics).toBeNull();
  });
});

describe('useReportesEconomia', () => {
  it('10 · el MRR sale de los grupos por plan (1,200 membresías) sin leer una fila por membresía', async () => {
    h.rpc.membresias_vivas_por_tier = { data: [{ tier_id: 'tr', status: 'activa', n: 1200 }], error: null };
    const { result } = renderHook(() => useReportesEconomia());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.mrrCentavos).toBe(1200 * 85000);
    expect(result.current.data?.activosConPlan).toBe(1200);
    // La única lectura de `membresias` que queda es el CONTEO de bajas (head); las vivas vienen agrupadas.
    expect(h.llamadas.map((l) => l.fn)).toEqual(['membresias_vivas_por_tier']);
  });

  it('13 · el RPC falla → error', async () => {
    h.rpc.membresias_vivas_por_tier = { data: null, error: { message: 'x' } };
    const { result } = renderHook(() => useReportesEconomia());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe(true);
  });
});
