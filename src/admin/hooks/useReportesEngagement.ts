import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import {
  calcularEngagement,
  type EngagementResult,
  type MiembroLite,
  type ReservaEngLite
} from '../logic/reportesEngagement';

// ============================================================================
// useReportesEngagement — uso real del estudio: MAU, % que vienen, activación,
// time-to-value y la lista de miembros en riesgo. Lee miembros activos, la
// cohorte de nuevos (90d) y las reservas del período. Scopeado por tenant.
// ============================================================================

const VENTANA_DIAS = 90;

export function useReportesEngagement() {
  const tenant = useTenant();
  const [data, setData] = useState<EngagementResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const ahoraMs = Date.now();
    const hace90d = new Date(ahoraMs - VENTANA_DIAS * 24 * 60 * 60 * 1000).toISOString();

    const [activosRes, reservasRes] = await Promise.all([
      supabase
        .from('usuarios')
        .select('id, nombre, email, telefono, created_at')
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .eq('status', 'activo'),
      supabase
        .from('reservas')
        .select('usuario_id, slot_inicio, status, created_at')
        .eq('tenant_id', tenant.id)
        .gte('slot_inicio', hace90d)
    ]);

    if (activosRes.error || reservasRes.error) {
      console.error('[useReportesEngagement]', activosRes.error || reservasRes.error);
      setError(true);
      setIsLoading(false);
      return;
    }

    const activos = (activosRes.data ?? []) as MiembroLite[];
    const nuevos90d = activos.filter((m) => new Date(m.created_at).getTime() >= new Date(hace90d).getTime());

    setData(
      calcularEngagement(activos, (reservasRes.data ?? []) as ReservaEngLite[], nuevos90d, ahoraMs)
    );
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
