import { useCallback, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useVisibilityAwarePolling } from '@shared/hooks/useVisibilityAwarePolling';

export interface Notificacion {
  id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  metadata: Record<string, unknown> | null;
  creada_at: string;
  leida: boolean;
}

/**
 * Avisos que NO se marcan como leídos desde la campana: el de "cambia tu contraseña
 * temporal" es lo que mantiene encendido `CambiarPasswordGate`; solo se apaga cuando
 * de verdad se cambia la clave. Marcarlo leído desactivaba el gate sin cambiarla.
 */
export const TIPOS_QUE_NO_SE_DESCARTAN = ['cambiar_password'];

/** Cuántos avisos recientes se muestran (leídos y no leídos). */
export const MAX_AVISOS = 20;

const POLLING_INTERVAL_MS = 30_000;

/**
 * Avisos in-app recientes del usuario actual: LEÍDOS Y NO LEÍDOS.
 *
 * Antes solo traía los no leídos y con `limit(5)`: tocar un aviso lo hacía
 * desaparecer para siempre (una cancelación del estudio, "tu material está listo",
 * un plan por vencer leídos por accidente se perdían), con más de 5 el contador
 * mentía, y "Marcar todas" solo marcaba las 5 visibles. Ahora es un historial: lo
 * leído se atenúa, no se borra. (SALA: useNotificaciones.ts.)
 *
 * Polling cada 30s con pausa cuando la tab está inactiva
 * (visibilityChange). Refetch automático al volver a la tab.
 * Errores de polling se loguean en silencio (no spamean al miembro).
 */
export function useNotificacionesMiembro() {
  const { usuario } = useAuth();
  const [notificaciones, setNotificaciones] = useState<Notificacion[]>([]);

  const refetch = useCallback(async () => {
    if (!usuario) {
      setNotificaciones([]);
      return;
    }
    const { data, error } = await supabase
      .from('notificaciones')
      .select('id, tipo, titulo, mensaje, metadata, creada_at, leida')
      .eq('usuario_id', usuario.id)
      .order('creada_at', { ascending: false })
      .limit(MAX_AVISOS);

    if (error) {
      console.error('[useNotificacionesMiembro]', error);
      return;
    }
    setNotificaciones((data ?? []) as Notificacion[]);
  }, [usuario]);

  useVisibilityAwarePolling(refetch, POLLING_INTERVAL_MS, !!usuario);

  // Optimista, y se REVIERTE si el servidor no lo guardó (antes ni se miraba el error:
  // el aviso desaparecía de la pantalla y volvía en el siguiente sondeo).
  const marcarLeida = useCallback(async (id: string) => {
    const aviso = notificaciones.find((n) => n.id === id);
    if (aviso && TIPOS_QUE_NO_SE_DESCARTAN.includes(aviso.tipo)) return;
    setNotificaciones((prev) => prev.map((n) => (n.id === id ? { ...n, leida: true } : n)));
    const { error } = await supabase
      .from('notificaciones')
      .update({ leida: true, leida_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      console.error('[useNotificacionesMiembro] marcarLeida', error);
      setNotificaciones((prev) => prev.map((n) => (n.id === id ? { ...n, leida: false } : n)));
    }
  }, [notificaciones]);

  // TODAS las no leídas del usuario (una sola sentencia), no solo las visibles.
  const marcarTodas = useCallback(async () => {
    if (!usuario) return;
    const antes = notificaciones;
    setNotificaciones((prev) =>
      prev.map((n) => (TIPOS_QUE_NO_SE_DESCARTAN.includes(n.tipo) ? n : { ...n, leida: true }))
    );
    const { error } = await supabase
      .from('notificaciones')
      .update({ leida: true, leida_at: new Date().toISOString() })
      .eq('usuario_id', usuario.id)
      .eq('leida', false)
      .not('tipo', 'in', `(${TIPOS_QUE_NO_SE_DESCARTAN.join(',')})`);
    if (error) {
      console.error('[useNotificacionesMiembro] marcarTodas', error);
      setNotificaciones(antes);
    }
  }, [usuario, notificaciones]);

  const noLeidas = notificaciones.filter((n) => !n.leida).length;

  return { notificaciones, noLeidas, marcarLeida, marcarTodas, refetch };
}
