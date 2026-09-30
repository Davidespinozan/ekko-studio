import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface PlanActivo {
  slug: string;
  nombre: string;
  /** PKG-01D: precio de lista para MOSTRAR el importe de una venta de mostrador (el servidor lo deriva por su cuenta). */
  precio_centavos: number | null;
}

/**
 * Planes (tiers) ACTIVOS, para poblar cualquier selector de plan (registrar
 * miembro, editar miembro, asignar plan, etc.). Fuente única: la BD.
 * Antes cada modal hardcodeaba "basica"/"pro" y quedaba desincronizado cuando
 * los planes cambiaban.
 *
 * El tenant lo limita RLS (mismo criterio que las otras queries de recepción),
 * por eso NO usamos useTenant: así el hook no depende de <TenantProvider> y es
 * usable en cualquier superficie (y testeable sin envolver en providers).
 */
export function usePlanesActivos() {
  const [planes, setPlanes] = useState<PlanActivo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02): un fallo al leer los planes no es "no hay planes": los
  // selectores lo dicen y no dejan asignar con datos desconocidos.
  const [error, setError] = useState(false);
  const [intento, setIntento] = useState(0);
  const recargar = useCallback(() => setIntento((n) => n + 1), []);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setIsLoading(true);
      setError(false);
      const { data, error: qErr } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos')
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (qErr) {
        console.error('[usePlanesActivos]', qErr);
        setError(true); // la lista anterior se conserva
      } else {
        setPlanes((data ?? []) as PlanActivo[]);
      }
      setIsLoading(false);
    }
    load();
    return () => {
      mounted = false;
    };
  }, [intento]);

  return { planes, isLoading, error, recargar };
}
