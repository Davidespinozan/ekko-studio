import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

// ============================================================================
// useResumenMiembro — datos para el "panel" del Home del miembro.
//
// Reúne en una sola pasada lo que antes estaba disperso (próximas reservas,
// sesiones del mes y estado de la membresía) para pintar el carnet dorado y la
// fila de chips de resumen. Todo tolerante a fallo: si una query falla, ese
// campo queda en su default y el resto se muestra igual.
// ============================================================================

export interface ResumenMiembro {
  proximasCount: number;
  sesionesEsteMes: number;
  membresia: {
    status: string | null;
    creditosRestantes: number | null;
    periodoActualFin: string | null;
  } | null;
  tier: {
    nombre: string;
    tipo: string;
  } | null;
}

const VACIO: ResumenMiembro = {
  proximasCount: 0,
  sesionesEsteMes: 0,
  membresia: null,
  tier: null
};

export function useResumenMiembro(
  usuarioId: string | undefined,
  tenantId: string | undefined,
  membresiaTier: string | null | undefined
) {
  const [resumen, setResumen] = useState<ResumenMiembro>(VACIO);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!usuarioId) {
      setResumen(VACIO);
      setIsLoading(false);
      return;
    }
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const inicioMes = new Date();
      inicioMes.setDate(1);
      inicioMes.setHours(0, 0, 0, 0);
      const ahoraIso = new Date().toISOString();

      const [proximasRes, sesionesRes, memRes, tierRes] = await Promise.all([
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', usuarioId!)
          .eq('status', 'confirmada')
          .gte('slot_inicio', ahoraIso),
        supabase
          .from('reservas')
          .select('id', { count: 'exact', head: true })
          .eq('usuario_id', usuarioId!)
          .eq('status', 'completada')
          .gte('check_in_at', inicioMes.toISOString()),
        supabase
          .from('membresias')
          .select('status, creditos_restantes, periodo_actual_fin')
          .eq('usuario_id', usuarioId!)
          .order('created_at', { ascending: false })
          .limit(1),
        membresiaTier && tenantId
          ? supabase
              .from('tiers')
              .select('nombre, tipo')
              .eq('tenant_id', tenantId)
              .eq('slug', membresiaTier)
              .maybeSingle()
          : Promise.resolve({ data: null })
      ]);

      if (!mounted) return;

      const mem = (memRes.data ?? [])[0] as
        | { status: string | null; creditos_restantes: number | null; periodo_actual_fin: string | null }
        | undefined;
      const tier = (tierRes.data ?? null) as { nombre: string; tipo: string } | null;

      setResumen({
        proximasCount: proximasRes.count ?? 0,
        sesionesEsteMes: sesionesRes.count ?? 0,
        membresia: mem
          ? {
              status: mem.status,
              creditosRestantes: mem.creditos_restantes,
              periodoActualFin: mem.periodo_actual_fin
            }
          : null,
        tier
      });
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [usuarioId, tenantId, membresiaTier]);

  return { resumen, isLoading };
}
