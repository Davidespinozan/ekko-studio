import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface PlanActivo {
  slug: string;
  nombre: string;
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

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre')
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (error) console.error('[usePlanesActivos]', error);
      else setPlanes((data ?? []) as PlanActivo[]);
      setIsLoading(false);
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  return { planes, isLoading };
}
