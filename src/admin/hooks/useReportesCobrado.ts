import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { inicioDeMesEnZona } from '@shared/lib/timezone';
import { calcularCobrado, type CobradoResult, type LibroFila, type PagoFallido } from '../logic/reportesCobrado';

/**
 * Lo COBRADO de verdad del mes actual vs. anterior (bruto, reversado y neto,
 * desde el libro económico) y los cobros fallidos. Complementa el MRR (ingreso
 * contratado). Lee desde el inicio del mes anterior y delega al cálculo puro.
 */
export function useReportesCobrado() {
  const tenant = useTenant();
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
      // R2-B (PKG-01N): el dinero sale del LIBRO ECONÓMICO (cobros firmes de Stripe
      // y de mostrador, reversales exactos, lo no atribuible aparte). Cast: la RPC
      // aún no está en los tipos generados.
      const { data: filas, error: err } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>
      ) => Promise<{ data: LibroFila[] | null; error: { message: string } | null }>)('libro_economico', {
        p_desde: desde.toISOString(),
        p_hasta: new Date(ahora.getTime() + 60_000).toISOString()
      });
      if (err) throw err;
      // Cobros fallidos: no son ingreso; siguen saliendo del diario de Stripe.
      const { data: fallidos, error: errF } = await supabase
        .from('payment_events')
        .select('created_at, monto_centavos')
        .eq('tenant_id', tenant.id)
        .eq('status', 'failed')
        .gte('created_at', desde.toISOString())
        .limit(2000);
      if (errF) throw errF;
      setData(calcularCobrado(filas ?? [], inicioMes, inicioMesAnterior, ahora, (fallidos ?? []) as PagoFallido[]));
    } catch (e) {
      console.error('[useReportesCobrado]', e);
      setError(true);
    } finally {
      setIsLoading(false);
    }
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, isLoading, error, refetch };
}
