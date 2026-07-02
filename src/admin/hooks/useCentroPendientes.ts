import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { ConteoPendientes } from '../logic/centroPendientes';

// ============================================================================
// useCentroPendientes — conteos de los pendientes operativos del admin
// (cobros, identidad, membresías vencidas, no-shows). Todo scopeado por tenant
// vía RLS. Tolerante a fallo: un conteo que falle queda en 0.
// ============================================================================

const VACIO: ConteoPendientes = {
  cobrosPendientes: 0,
  identidadPendiente: 0,
  membresiasVencidas: 0,
  noShows7d: 0
};

export function useCentroPendientes() {
  const tenant = useTenant();
  const [conteo, setConteo] = useState<ConteoPendientes>(VACIO);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
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
        .in('status', ['activa', 'active'])
        .lt('periodo_actual_fin', now.toISOString()),
      supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'no_show')
        .gte('slot_inicio', hace7d.toISOString())
    ]);

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

  return { conteo, isLoading, refetch };
}
