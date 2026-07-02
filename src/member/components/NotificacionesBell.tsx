import { useEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck } from 'lucide-react';
import { useNotificacionesMiembro } from '@shared/hooks/useNotificacionesMiembro';
import { tiempoRelativo } from '@shared/lib/tiempoRelativo';

// ============================================================================
// NotificacionesBell — campana con badge de no-leídas + panel desplegable.
// Reemplaza el banner sticky: menos intrusivo, siempre accesible desde el
// header. Tocar una notificación la marca como leída. Patrón tomado de SALA.
// ============================================================================

export function NotificacionesBell() {
  const { notificaciones, marcarLeida } = useNotificacionesMiembro();
  const [abierto, setAbierto] = useState(false);
  const contenedorRef = useRef<HTMLDivElement>(null);

  const cantidad = notificaciones.length;

  // Cerrar al hacer click fuera o con Escape.
  useEffect(() => {
    if (!abierto) return;
    function onClick(e: MouseEvent) {
      if (contenedorRef.current && !contenedorRef.current.contains(e.target as Node)) {
        setAbierto(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setAbierto(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [abierto]);

  async function marcarTodas() {
    await Promise.all(notificaciones.map((n) => marcarLeida(n.id)));
  }

  return (
    <div ref={contenedorRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="ek-bell"
        aria-label={cantidad > 0 ? `Notificaciones (${cantidad} sin leer)` : 'Notificaciones'}
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
      >
        <Bell size={20} aria-hidden="true" />
        {cantidad > 0 && <span className="ek-bell-badge">{cantidad > 9 ? '9+' : cantidad}</span>}
      </button>

      {abierto && (
        <div className="ek-bell-panel ek-scale-in" role="dialog" aria-label="Notificaciones">
          <div className="ek-bell-panel-head">
            <span className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>NOTIFICACIONES</span>
            {cantidad > 0 && (
              <button type="button" className="ek-bell-marcar" onClick={() => void marcarTodas()}>
                <CheckCheck size={14} aria-hidden="true" /> Marcar todas
              </button>
            )}
          </div>

          {cantidad === 0 ? (
            <div className="ek-bell-empty">
              <Check size={22} aria-hidden="true" style={{ color: 'var(--ek-success)' }} />
              <p style={{ margin: '8px 0 0', fontSize: '13.5px', color: 'var(--ek-ink-muted)' }}>Estás al día</p>
            </div>
          ) : (
            <ul className="ek-bell-list">
              {notificaciones.map((n) => (
                <li key={n.id}>
                  <button type="button" className="ek-bell-item" onClick={() => void marcarLeida(n.id)}>
                    <span className="ek-bell-dot" aria-hidden="true" />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="ek-bell-item-title">{n.titulo}</span>
                      <span className="ek-bell-item-msg">{n.mensaje}</span>
                      <span className="ek-bell-item-time">{tiempoRelativo(n.creada_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
