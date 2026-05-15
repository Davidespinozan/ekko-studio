import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Usuario = Database['public']['Tables']['usuarios']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface ReservaConJoin extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier'> | null;
}

/**
 * Reservas del día actual del tenant, ordenadas por hora.
 * Polling cada 30s para mantener la vista actualizada.
 */
export function useReservasHoy() {
  const tenant = useTenant();
  const [reservas, setReservas] = useState<ReservaConJoin[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    const inicio = new Date();
    inicio.setHours(0, 0, 0, 0);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 1);

    const { data, error } = await supabase
      .from('reservas')
      .select('*, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)')
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', inicio.toISOString())
      .lt('slot_inicio', fin.toISOString())
      .order('slot_inicio', { ascending: true });

    if (error) {
      console.error('[useReservasHoy]', error);
      setIsLoading(false); // CRÍTICO: sin esto la UI queda en "cargando" para siempre
      return;
    }
    setReservas((data ?? []) as unknown as ReservaConJoin[]);
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    refetch();
    const interval = setInterval(refetch, 30_000); // 30s polling
    return () => clearInterval(interval);
  }, [refetch]);

  return { reservas, isLoading, refetch };
}

/**
 * Marca un check-in manual sin pasar por QR.
 *
 * NOTA: `check_in_manual_atomic` está en la migración 20260514140000 (nueva).
 * Hasta que David la aplique y regenere los tipos, no aparece en `Database`,
 * por eso el cast a `any` en el rpc. Quitar el cast después de regenerar.
 */
export async function checkInManual(reservaId: string, motivo?: string) {
  // Cast a any porque check_in_manual_atomic vive en la migración 140000 (no
  // aplicada todavía), por eso aún no aparece en `Database`. Quitar el cast
  // después de aplicar la migración y regenerar tipos.
  const { data, error } = await (supabase.rpc as any)('check_in_manual_atomic', {
    p_reserva_id: reservaId,
    p_motivo: motivo ?? undefined
  });

  if (error) {
    const code = error.message.match(/EKKO_[A-Z_]+/)?.[0] ?? 'EKKO_ERROR';
    throw new Error(translateError(code, error.message));
  }
  return data;
}

function translateError(code: string, fallback: string): string {
  const map: Record<string, string> = {
    EKKO_RESERVA_NO_EXISTE: 'Reserva no encontrada',
    EKKO_YA_CHECK_IN: 'Este miembro ya hizo check-in',
    EKKO_RESERVA_CANCELADA: 'Reserva cancelada',
    EKKO_RESERVA_NO_SHOW: 'Reserva marcada como inasistencia',
    EKKO_DEMASIADO_TEMPRANO: 'Es muy temprano para el check-in',
    EKKO_DEMASIADO_TARDE: 'El check-in ya cerró',
    EKKO_NO_AUTORIZADO: 'No autorizado'
  };
  return map[code] ?? fallback.replace(code + ':', '').trim();
}
