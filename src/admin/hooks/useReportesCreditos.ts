import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { creditosDesdeTotales, type CreditosResult, type CreditosTotales } from '../logic/reportesCreditos';

// ============================================================================
// useReportesCreditos — pasivo de créditos: vendidos vs usados y saldo vivo.
// PKG-06F (FR-62/63): los totales los calcula la base (`reporte_creditos`, ledger
// COMPLETO del estudio del admin). Antes se traía el ledger crudo y se sumaba
// aquí: con más de 1000 movimientos el total salía corto sin avisar.
// ============================================================================

export function useReportesCreditos() {
  const [data, setData] = useState<CreditosResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);

    const { data: filas, error: err } = await (supabase.rpc as unknown as <T>(fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: T | null; error: { message: string } | null }>)<CreditosTotales[]>('reporte_creditos');
    const totales = filas?.[0];
    if (err || !totales) {
      // Un fallo NO es "cero créditos": la tarjeta muestra el error.
      console.error('[useReportesCreditos]', err ?? 'sin fila');
      setError(true);
      setIsLoading(false);
      return;
    }
    setData(creditosDesdeTotales(totales));
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
