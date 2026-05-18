import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';

export interface Notificacion {
  id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  metadata: Record<string, unknown> | null;
  creada_at: string;
}

const POLLING_INTERVAL_MS = 30_000;

/**
 * Lista notificaciones in-app no leídas del usuario actual.
 *
 * Polling cada 30s con pausa cuando la tab está inactiva
 * (visibilityChange). Refetch automático al volver a la tab.
 * Errores de polling se loguean en silencio (no spamean al miembro).
 */
export function useNotificacionesMiembro() {
  const { usuario } = useAuth();
  const [notificaciones, setNotificaciones] = useState<Notificacion[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setNotificaciones([]);
      return;
    }
    const { data, error } = await supabase
      .from('notificaciones')
      .select('id, tipo, titulo, mensaje, metadata, creada_at')
      .eq('usuario_id', usuario.id)
      .eq('leida', false)
      .order('creada_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('[useNotificacionesMiembro]', error);
      return;
    }
    setNotificaciones((data ?? []) as Notificacion[]);
  }, [usuario]);

  useEffect(() => {
    if (!usuario) return;

    const startPolling = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(() => {
        void refetch();
      }, POLLING_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refetch();
        startPolling();
      } else {
        stopPolling();
      }
    };

    void refetch();
    if (document.visibilityState === 'visible') {
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [usuario, refetch]);

  const marcarLeida = useCallback(async (id: string) => {
    await supabase
      .from('notificaciones')
      .update({ leida: true, leida_at: new Date().toISOString() })
      .eq('id', id);
    setNotificaciones((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { notificaciones, marcarLeida, refetch };
}
