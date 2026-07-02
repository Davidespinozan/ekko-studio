import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import {
  calcularEconomia,
  type EconomiaResult,
  type TierLite,
  type MembresiaLite
} from '../logic/reportesEconomia';

// ============================================================================
// useReportesEconomia — KPIs de negocio recurrente (MRR, ARR, ARPU, churn, LTV).
// Lee tiers, membresías facturables y bajas de 90d, y delega el cálculo a la
// lógica pura. Todo scopeado por tenant vía RLS. Tolerante a fallo.
// ============================================================================

export function useReportesEconomia() {
  const tenant = useTenant();
  const [data, setData] = useState<EconomiaResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const hace90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const [tiersRes, membresiasRes, bajasRes] = await Promise.all([
      supabase
        .from('tiers')
        .select('id, slug, nombre, precio_centavos, periodo, moneda')
        .eq('tenant_id', tenant.id),
      supabase
        .from('membresias')
        .select('tier_id, status')
        .eq('tenant_id', tenant.id)
        .in('status', ['activa', 'trialing', 'past_due']),
      supabase
        .from('membresias')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'cancelada')
        .gte('cancelada_at', hace90d)
    ]);

    if (tiersRes.error || membresiasRes.error || bajasRes.error) {
      console.error('[useReportesEconomia]', tiersRes.error || membresiasRes.error || bajasRes.error);
      setError(true);
      setIsLoading(false);
      return;
    }

    setData(
      calcularEconomia(
        (tiersRes.data ?? []) as TierLite[],
        (membresiasRes.data ?? []) as MembresiaLite[],
        bajasRes.count ?? 0
      )
    );
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
