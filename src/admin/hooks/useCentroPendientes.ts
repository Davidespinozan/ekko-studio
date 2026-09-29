import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { ConteoPendientes } from '../logic/centroPendientes';

const VACIO: ConteoPendientes = {
  cobrosPendientes: 0,
  identidadPendiente: 0,
  membresiasVencidas: 0,
  noShows7d: 0
};

/**
 * Conteos crudos del centro de pendientes del admin. La lógica de qué mostrar
 * y en qué orden vive en `logic/centroPendientes.ts` (pura).
 *
 * PKG-02A (C02): si CUALQUIERA de los 4 counts falla, `error=true` y el conteo
 * anterior se conserva tal cual (no se suman parciales ni se rellena con 0):
 * un 0 falso aquí se leía como "Todo al día".
 */
export function useCentroPendientes() {
  const tenant = useTenant();
  const [conteo, setConteo] = useState<ConteoPendientes>(VACIO);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(false);
    const now = new Date();
    const hace7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [cobros, identidad, vencidas, noShows] = await Promise.all([
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .eq('status', 'pendiente_pago'),
      supabase
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('rol', 'miembro')
        .eq('status', 'activo')
        .eq('identidad_completa', false),
      supabase
        .from('membresias')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        // 'activa' y 'past_due' con el periodo ya terminado = vencidas operativas
        // (past_due sigue dando acceso pero requiere acción). 'active' no existe
        // en membresias (era valor muerto).
        .in('status', ['activa', 'past_due'])
        .lt('periodo_actual_fin', now.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', hace7d.toISOString())
    ]);

    const fallo = [cobros, identidad, vencidas, noShows].find((r) => r.error);
    if (fallo) {
      console.error('[useCentroPendientes]', fallo.error);
      setError(true);
      setIsLoading(false);
      return;
    }

    setConteo({
      cobrosPendientes: cobros.count ?? 0,
      identidadPendiente: identidad.count ?? 0,
      membresiasVencidas: vencidas.count ?? 0,
      noShows7d: noShows.count ?? 0
    });
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { conteo, isLoading, error, refetch };
}
