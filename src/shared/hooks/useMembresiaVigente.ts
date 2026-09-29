import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

export interface MembresiaVigente {
  id: string;
  status: string;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean | null;
  created_at: string;
  tier: { slug: string; nombre: string; tipo: string | null } | null;
}

/**
 * Membresía VIVA (trialing/activa/past_due) de un miembro, desde `membresias`
 * — la fuente de verdad de reportes y webhook — con su plan. La leen admin
 * (membresias_read_admin) y recepción (membresias_read_staff). null si no hay.
 */
export function useMembresiaVigente(usuarioId: string | null | undefined) {
  const [membresia, setMembresia] = useState<MembresiaVigente | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(usuarioId));
  // PKG-02A (C02): un error al leer NO es "sin membresía". Con `error=true` la
  // pantalla debe mostrar el fallo y no ofrecer acciones basadas en la ausencia.
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    if (!usuarioId) {
      setMembresia(null);
      setError(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(false);
    try {
      const { data, error: qErr } = await supabase
        .from('membresias')
        .select('id, status, periodo_actual_fin, creditos_restantes, stripe_subscription_id, cancel_at_period_end, created_at, tier:tiers(slug, nombre, tipo)')
        .eq('usuario_id', usuarioId)
        .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (qErr) {
        console.error('[useMembresiaVigente]', qErr);
        setError(true); // se conserva la membresía anterior (o null si nunca cargó)
        return;
      }
      setMembresia((data as unknown as MembresiaVigente | null) ?? null);
    } catch (e) {
      // Nunca tumbar la ficha/check-in por un fallo al leer la membresía.
      console.error('[useMembresiaVigente]', e instanceof Error ? e.message : e);
      setError(true);
    } finally {
      setIsLoading(false);
    }
  }, [usuarioId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { membresia, isLoading, error, refetch };
}
