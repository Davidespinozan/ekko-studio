import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
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
    const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

    const [recursosRes, reservasRes] = await Promise.all([
      supabase
        .from('recursos')
        .select('id, nombre, cupos, horarios')
        .eq('tenant_id', tenant.id)
        .eq('activo', true),
      supabase
        .from('reservas')
        .select('recurso_id, status, duracion_min, slot_inicio')
        .eq('tenant_id', tenant.id)
        .gte('slot_inicio', desde)
    ]);

    if (recursosRes.error || reservasRes.error) {
      console.error('[useReportesOcupacion]', recursosRes.error || reservasRes.error);
      setError(true);
      setIsLoading(false);
      return;
    }

    setData(
      calcularOcupacion(
        (recursosRes.data ?? []) as unknown as RecursoLite[],
        (reservasRes.data ?? []) as unknown as ReservaLite[],
        DIAS
      )
    );
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
