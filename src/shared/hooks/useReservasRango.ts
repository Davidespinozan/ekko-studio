import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { COLUMNAS_RESERVA_CLIENTE } from '@shared/lib/columnas';
import { useTenant } from '@shared/hooks/useTenant';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Usuario = Database['public']['Tables']['usuarios']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface ReservaRango extends Reserva {
  recurso: Pick<Recurso, 'id' | 'slug' | 'nombre'> | null;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'email' | 'membresia_tier'> | null;
}

/**
 * Reservas en un rango de fechas para vista calendario. Tenant-scoped y
 * read-only — lo comparten admin (Calendario) y recepción (Agenda). La RLS
 * `reservas_read_admin` (is_recepcionista) cubre a ambos roles.
 *
 * Primitivos estables: los callers pasan objetos Date nuevos cada render;
 * depender del objeto causaría refetch en loop.
 */
export function useReservasRango(fechaInicio: Date, fechaFin: Date) {
  const tenant = useTenant();
  const [reservas, setReservas] = useState<ReservaRango[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): un fetch fallido no es "período vacío". `cargado` distingue el
  // primer fallo (error) de un refresh fallido con dato previo (stale).
  const [error, setError] = useState(false);
  const [cargado, setCargado] = useState(false);

  const inicioMs = fechaInicio.getTime();
  const finMs = fechaFin.getTime();

  const refetch = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('reservas')
      .select(`${COLUMNAS_RESERVA_CLIENTE}, recurso:recursos(id, slug, nombre), usuario:usuarios!reservas_usuario_id_fkey(id, nombre, email, membresia_tier)`)
      .eq('tenant_id', tenant.id)
      .gte('slot_inicio', new Date(inicioMs).toISOString())
      .lt('slot_inicio', new Date(finMs).toISOString())
      .order('slot_inicio', { ascending: true });

    if (error) {
      console.error('[useReservasRango]', error);
      setError(true); // las reservas anteriores (si las hay) se conservan
      setIsLoading(false);
      return;
    }
    setReservas((data ?? []) as unknown as ReservaRango[]);
    setError(false);
    setCargado(true);
    setIsLoading(false);
  }, [tenant.id, inicioMs, finMs]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { reservas, isLoading, error, cargado, refetch };
}
