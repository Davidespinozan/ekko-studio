import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import {
  calcularCreditos,
  type CreditosResult,
  type MovimientoLite,
  type SaldoLite
} from '../logic/reportesCreditos';

// ============================================================================
// useReportesCreditos — pasivo de créditos: vendidos vs usados y saldo vivo.
// Lee el ledger (membresia_movimientos, RLS admin) + los saldos de membresías
// con su plan, y delega el cálculo a la lógica pura. Scopeado por tenant.
// ============================================================================

// Fila de saldo con el plan anidado (join to-one tier).
interface SaldoRow {
  creditos_restantes: number | null;
  tier: { precio_centavos: number | null; clases_incluidas: number | null } | null;
}

export function useReportesCreditos() {
  const tenant = useTenant();
  const [data, setData] = useState<CreditosResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);

    const [movsRes, saldosRes] = await Promise.all([
      // Ledger completo del tenant (append-only; en etapa temprana es pequeño).
      supabase
        .from('membresia_movimientos')
        .select('tipo, delta')
        .eq('tenant_id', tenant.id),
      // Saldos vivos + precio/cupo del plan para valorar el pasivo.
      supabase
        .from('membresias')
        .select('creditos_restantes, tier:tiers(precio_centavos, clases_incluidas)')
        .eq('tenant_id', tenant.id)
        .in('status', ['trialing', 'activa', 'past_due'])
        .not('creditos_restantes', 'is', null)
    ]);

    if (movsRes.error || saldosRes.error) {
      console.error('[useReportesCreditos]', movsRes.error || saldosRes.error);
      setError(true);
      setIsLoading(false);
      return;
    }

    const saldos: SaldoLite[] = ((saldosRes.data ?? []) as unknown as SaldoRow[]).map((r) => ({
      creditos_restantes: r.creditos_restantes,
      precio_centavos: r.tier?.precio_centavos ?? null,
      clases_incluidas: r.tier?.clases_incluidas ?? null
    }));

    setData(calcularCreditos((movsRes.data ?? []) as MovimientoLite[], saldos));
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
