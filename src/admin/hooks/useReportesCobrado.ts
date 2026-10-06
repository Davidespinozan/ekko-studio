import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { inicioDeMesEnZona } from '@shared/lib/timezone';
import { calcularCobradoAgregado, type CobradoResult, type FallidosResumen, type LibroGrupo } from '../logic/reportesCobrado';

/**
 * Lo COBRADO de verdad del mes actual vs. anterior (bruto, reversado y neto,
 * desde el libro económico) y los cobros fallidos. Complementa el MRR (ingreso
 * contratado). Lee desde el inicio del mes anterior y delega al cálculo puro.
 */
export function useReportesCobrado() {
  const [data, setData] = useState<CobradoResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const ahora = new Date();
    const inicioMes = inicioDeMesEnZona(0, ahora);
    const inicioMesAnterior = inicioDeMesEnZona(-1, ahora);
    const desde = new Date(Math.min(inicioMesAnterior.getTime(), ahora.getTime() - 31 * 24 * 60 * 60 * 1000));
    try {
      // R2-B (PKG-01N): el dinero sale del LIBRO ECONÓMICO. PKG-06F (FR-62/63): la
      // base lo devuelve AGRUPADO por periodo, clase, origen, moneda y estado (unos
      // pocos renglones sin importar cuántos cobros haya); la lógica del KPI no cambia.
      const { data: grupos, error: err } = await (supabase.rpc as unknown as <T>(fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: T | null; error: { message: string } | null }>)<LibroGrupo[]>('libro_economico_agregado', {
        p_desde: desde.toISOString(),
        p_inicio_mes_anterior: inicioMesAnterior.toISOString(),
        p_inicio_mes: inicioMes.toISOString(),
        p_hasta: new Date(ahora.getTime() + 60_000).toISOString()
      });
      if (err) throw err;
      // Cobros fallidos de los últimos 30 días, contados en la base (antes: filas
      // crudas con un tope que el servidor recortaba a 1000).
      const { data: fallidos, error: errF } = await (supabase.rpc as unknown as <T>(fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: T | null; error: { message: string } | null }>)<FallidosResumen[]>('cobros_fallidos_resumen', {
        p_desde: new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
      });
      if (errF) throw errF;
      if (!fallidos?.[0]) throw new Error('cobros_fallidos_resumen sin fila');
      setData(calcularCobradoAgregado(grupos ?? [], fallidos[0]));
    } catch (e) {
      console.error('[useReportesCobrado]', e);
      setError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
