import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, CheckCheck } from 'lucide-react';
import { useNotificacionesMiembro } from '@shared/hooks/useNotificacionesMiembro';
import { tiempoRelativo } from '@shared/lib/tiempoRelativo';

// ============================================================================
// NotificacionesBell — campana con badge de no-leídas + panel desplegable.
// Reemplaza el banner sticky: menos intrusivo, siempre accesible desde el
// header. Tocar una notificación la marca como leída y, si el aviso apunta a una
// pantalla (metadata.url: el QR de la reserva, Mi material…), lleva ahí. Lo leído se
// queda en la lista, atenuado: es un historial, no una bandeja que se vacía.
// ============================================================================

export function NotificacionesBell() {
  const { notificaciones, noLeidas, marcarLeida, marcarTodas } = useNotificacionesMiembro();
  const navigate = useNavigate();
  const [abierto, setAbierto] = useState(false);
  const contenedorRef = useRef<HTMLDivElement>(null);

  const cantidad = noLeidas;

  function abrirAviso(n: { id: string; leida: boolean; metadata: Record<string, unknown> | null }) {
    if (!n.leida) void marcarLeida(n.id);
    const url = n.metadata?.url;
    // Solo rutas internas: el destino viene de la base, nunca se abre un enlace externo.
    if (typeof url === 'string' && url.startsWith('/')) {
      setAbierto(false);
      navigate(url);
    }
  }

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

          {notificaciones.length === 0 ? (
            <div className="ek-bell-empty">
              <Check size={22} aria-hidden="true" style={{ color: 'var(--ek-success)' }} />
              <p style={{ margin: '8px 0 0', fontSize: '13.5px', color: 'var(--ek-ink-muted)' }}>Estás al día</p>
            </div>
          ) : (
            <ul className="ek-bell-list">
              {notificaciones.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="ek-bell-item"
                    onClick={() => abrirAviso(n)}
                    aria-label={`${n.leida ? '' : 'Sin leer: '}${n.titulo}`}
                    style={n.leida ? { opacity: 0.6 } : undefined}
                  >
                    <span className="ek-bell-dot" aria-hidden="true" style={n.leida ? { visibility: 'hidden' } : undefined} />
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
