import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';

/**
 * Historial de cambios (audit_log) de UN miembro, para mostrarlo read-only en
 * el perfil de recepción (Bloque A). RLS deja a recepción leer solo entradas
 * con target_tipo='usuario' de su tenant.
 */

export interface AuditEntryUsuario {
  id: string;
  accion: string;
  actor_rol: string | null;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
  motivo: string | null;
  creada_at: string;
}

interface Estado {
  entries: AuditEntryUsuario[];
  isLoading: boolean;
  error: boolean;
}

export function useAuditLogDeUsuario(usuarioId: string | undefined) {
  const [estado, setEstado] = useState<Estado>({ entries: [], isLoading: true, error: false });

  const recargar = useCallback(async () => {
    if (!usuarioId) return;
    setEstado((s) => ({ ...s, isLoading: true, error: false }));
    const { data, error } = await supabase
      .from('audit_log')
      .select('id, accion, actor_rol, antes, despues, motivo, creada_at')
      .eq('target_tipo', 'usuario')
      .eq('target_id', usuarioId)
      .order('creada_at', { ascending: false })
      .limit(20);
    if (error) {
      setEstado({ entries: [], isLoading: false, error: true });
      return;
    }
    setEstado({ entries: (data ?? []) as unknown as AuditEntryUsuario[], isLoading: false, error: false });
  }, [usuarioId]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  return { ...estado, recargar };
}
