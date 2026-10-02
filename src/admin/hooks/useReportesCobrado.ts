import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { inicioDeMesEnZona } from '@shared/lib/timezone';
import { calcularCobrado, type CobradoResult, type PagoEvento, type ReembolsoEvento } from '../logic/reportesCobrado';

/**
 * Lo COBRADO de verdad (payment_events de Stripe) del mes actual vs. anterior,
 * reembolsos y cobros fallidos. Complementa el MRR (ingreso contratado).
 * Lee solo lo necesario (desde el inicio del mes anterior) y delega al cálculo puro.
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
      const { data: filas, error: err } = await supabase
        .from('payment_events')
        .select('created_at, monto_centavos, status, stripe_event_type')
        .eq('tenant_id', tenant.id)
        .gte('created_at', desde.toISOString())
        .order('created_at', { ascending: false })
        .limit(2000);
      if (err) throw err;
      // PKG-01G: reembolsos por objeto Refund (reversales_pago), no por evento acumulado.
      const { data: rv, error: errRv } = await supabase
        .from('reversales_pago')
        .select('stripe_object_id, monto_centavos, estado_proveedor, stripe_created_at, created_at')
        .eq('tenant_id', tenant.id)
        .eq('tipo', 'reembolso')
        .gte('created_at', desde.toISOString())
        .limit(2000);
      if (errRv) throw errRv;
      const reembolsos: ReembolsoEvento[] = (rv ?? []).map((r) => ({
        stripe_object_id: r.stripe_object_id,
        monto_centavos: r.monto_centavos,
        estado_proveedor: r.estado_proveedor,
        fecha: r.stripe_created_at ?? r.created_at
      }));
      setData(calcularCobrado((filas ?? []) as PagoEvento[], inicioMes, inicioMesAnterior, ahora, reembolsos));
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
