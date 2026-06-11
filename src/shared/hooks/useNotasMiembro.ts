import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';

/**
 * Bitácora operativa compartida de un miembro (Bloque E). Admin y recepción
 * del tenant leen; cada autor edita/borra lo suyo (admin todo). Va por
 * PostgREST directo — la RLS de `notas_miembro` protege el acceso.
 */

export interface NotaMiembro {
  id: string;
  contenido: string;
  autor_id: string;
  autor_rol: string;
  creada_at: string;
  actualizada_at: string | null;
  autor: { nombre: string | null } | null;
}

interface Estado {
  notas: NotaMiembro[];
  isLoading: boolean;
  error: boolean;
}

export function useNotasMiembro(miembroId: string | undefined) {
  const { usuario } = useAuth();
  const [estado, setEstado] = useState<Estado>({ notas: [], isLoading: true, error: false });

  const recargar = useCallback(async () => {
    if (!miembroId) return;
    setEstado((s) => ({ ...s, isLoading: true, error: false }));
    const { data, error } = await supabase
      .from('notas_miembro')
      .select('id, contenido, autor_id, autor_rol, creada_at, actualizada_at, autor:usuarios!notas_miembro_autor_id_fkey(nombre)')
      .eq('miembro_id', miembroId)
      .order('creada_at', { ascending: false });
    if (error) {
      console.error('[useNotasMiembro]', error);
      setEstado({ notas: [], isLoading: false, error: true });
      return;
    }
    setEstado({ notas: (data ?? []) as unknown as NotaMiembro[], isLoading: false, error: false });
  }, [miembroId]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const createNota = useCallback(
    async (contenido: string) => {
      if (!miembroId || !usuario) throw new Error('No autenticado');
      const { error } = await supabase.from('notas_miembro').insert({
        tenant_id: usuario.tenant_id,
        miembro_id: miembroId,
        autor_id: usuario.id,
        autor_rol: usuario.rol,
        contenido
      });
      if (error) throw new Error(error.message);
      await recargar();
    },
    [miembroId, usuario, recargar]
  );

  const updateNota = useCallback(
    async (id: string, contenido: string) => {
      const { error } = await supabase
        .from('notas_miembro')
        .update({ contenido, actualizada_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(error.message);
      await recargar();
    },
    [recargar]
  );

  const deleteNota = useCallback(
    async (id: string) => {
      const { error } = await supabase.from('notas_miembro').delete().eq('id', id);
      if (error) throw new Error(error.message);
      await recargar();
    },
    [recargar]
  );

  return { ...estado, recargar, createNota, updateNota, deleteNota };
}
