import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

// ============================================================================
// useResumenMiembro — datos para el "panel" del Home del miembro.
//
// Reúne en una sola pasada lo que antes estaba disperso (próximas reservas,
// sesiones del mes y estado de la membresía) para pintar el carnet dorado y la
// fila de chips de resumen.
//
// PKG-02A (C02): si CUALQUIERA de las consultas falla, `error=true` y el
// resumen anterior se conserva. Antes el campo fallido "quedaba en su default"
// → 0 créditos, 0 sesiones, sin plan: el miembro veía un carnet vacío y
// Reservar decidía con datos falsos.
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
    /** Invitados permitidos por sesión (reglas.max_invitados del plan). */
    maxInvitados: number;
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
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    if (!usuarioId) {
      setResumen(VACIO);
      setError(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(false);

    {
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
          .in('status', ['trialing', 'activa', 'past_due'])
          .order('created_at', { ascending: false })
          .limit(1),
        membresiaTier && tenantId
          ? supabase
              .from('tiers')
              .select('nombre, tipo, reglas')
              .eq('tenant_id', tenantId)
              .eq('slug', membresiaTier)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null })
      ]);

      const fallo = [proximasRes, sesionesRes, memRes, tierRes].find((r) => (r as { error?: unknown }).error);
      if (fallo) {
        console.error('[useResumenMiembro]', (fallo as { error?: unknown }).error);
        setError(true); // el resumen anterior se conserva; la UI no decide con esto
        setIsLoading(false);
        return;
      }

      const mem = (memRes.data ?? [])[0] as
        | { status: string | null; creditos_restantes: number | null; periodo_actual_fin: string | null }
        | undefined;
      const tierRaw = (tierRes.data ?? null) as
        | { nombre: string; tipo: string; reglas: Record<string, unknown> | null }
        | null;
      const maxInv = tierRaw?.reglas?.max_invitados;
      const tier = tierRaw
        ? {
            nombre: tierRaw.nombre,
            tipo: tierRaw.tipo,
            maxInvitados: typeof maxInv === 'number' && maxInv >= 0 ? maxInv : 0
          }
        : null;

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
  }, [usuarioId, tenantId, membresiaTier]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { resumen, isLoading, error, refetch };
}
