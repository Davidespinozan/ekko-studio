import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { leerTodo } from '@shared/lib/leerTodo';
import {
  calcularOcupacion,
  type OcupacionResult,
  type RecursoLite,
  type ReservaLite
} from '../logic/reportesOcupacion';

// ============================================================================
// useReportesOcupacion — ocupación por estudio, asistencia y heatmap de demanda
// sobre una ventana de 90 días. Lee recursos activos + reservas del período y
// delega el cálculo a la lógica pura. Scopeado por tenant vía RLS.
// ============================================================================

const DIAS = 90;

export function useReportesOcupacion() {
  const tenant = useTenant();
  const [data, setData] = useState<OcupacionResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const desde90 = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

    try {
      const [recursosRes, reservas] = await Promise.all([
        supabase
          .from('recursos')
          .select('id, nombre, cupos, horarios')
          .eq('tenant_id', tenant.id)
          .eq('activo', true),
        // PKG-06F (FR-62): la ventana de 90 días se lee COMPLETA (por páginas y
        // con conteo exacto); si no se puede, es error — nunca una ocupación parcial.
        leerTodo<ReservaLite>((desde, hasta) =>
          supabase
            .from('reservas')
            .select('recurso_id, status, duracion_min, slot_inicio', { count: 'exact' })
            .eq('tenant_id', tenant.id)
            .gte('slot_inicio', desde90)
            .order('id')
            .range(desde, hasta) as unknown as PromiseLike<{ data: ReservaLite[] | null; error: { message: string } | null; count: number | null }>
        )
      ]);
      if (recursosRes.error) throw recursosRes.error;
      setData(calcularOcupacion((recursosRes.data ?? []) as unknown as RecursoLite[], reservas, DIAS));
    } catch (e) {
      console.error('[useReportesOcupacion]', e);
      setError(true);
    }
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
