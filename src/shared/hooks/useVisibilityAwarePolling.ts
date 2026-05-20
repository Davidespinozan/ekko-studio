import { useEffect, useRef } from 'react';

/**
 * Polling visibility-aware (Sprint MA2).
 *
 * Ejecuta `poll` inmediatamente al montar y luego cada `intervalMs`
 * mientras la tab está visible. Pausa el interval cuando la tab pasa
 * a background (`visibilitychange`) y hace un refetch inmediato al
 * volver. Ahorra batería/datos en sesiones largas (ej. iPad de
 * recepción).
 *
 * `poll` debe ser estable (envolvelo en `useCallback`). Cuando su
 * identidad cambia, el efecto re-ejecuta: refetch inmediato + reinicia
 * el interval — mismo comportamiento que un `useEffect([poll])`.
 *
 * `enabled=false` desactiva todo (no fetch, no listener). Útil para
 * gatear el polling cuando aún no hay usuario/contexto.
 *
 * Patrón originado en `useNotificacionesMiembro` (M3) y `useReservasHoy`
 * (MA1); extraído acá para no duplicar la lógica.
 */
export function useVisibilityAwarePolling(
  poll: () => void | Promise<void>,
  intervalMs: number,
  enabled = true
): void {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const startPolling = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(() => {
        void poll();
      }, intervalMs);
    };

    const stopPolling = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll();
        startPolling();
      } else {
        stopPolling();
      }
    };

    void poll();
    if (document.visibilityState === 'visible') {
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [poll, intervalMs, enabled]);
}
