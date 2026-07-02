import { StatusBadge } from '@shared/components/StatusBadge';
import { fechaHora } from './perfilUtils';
import type { ReservaPerfil } from './types';

/** Fila de reserva del perfil: hora + estudio, con acciones (próximas) o estado. */
export function FilaReserva({
  reserva,
  historico,
  onCancelar,
  onReprogramar,
  reprogramarBloqueado
}: {
  reserva: ReservaPerfil;
  historico?: boolean;
  onCancelar?: () => void;
  onReprogramar?: () => void;
  reprogramarBloqueado?: boolean;
}) {
  const cancelada = reserva.status === 'cancelada' || reserva.status === 'cancelada_admin';
  const conAcciones = onCancelar != null || onReprogramar != null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        background: 'var(--ek-bg-soft)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-sm)',
        opacity: historico && cancelada ? 0.55 : 1
      }}
    >
      <span style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '13px', fontWeight: 600, color: 'var(--ek-ink)', minWidth: '92px' }}>
        {fechaHora(reserva.slot_inicio)}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: '13px', color: 'var(--ek-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {reserva.recurso?.nombre ?? '—'}
      </span>
      {conAcciones ? (
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {onReprogramar && (
            <button
              type="button"
              onClick={onReprogramar}
              disabled={reprogramarBloqueado}
              title={reprogramarBloqueado ? 'El miembro no está activo — no se puede reprogramar' : undefined}
              style={{
                minHeight: '44px', padding: '4px 8px', background: 'transparent', border: 'none',
                color: reprogramarBloqueado ? 'var(--ek-ink-faint)' : 'var(--ek-mustard)',
                fontSize: '12px', fontWeight: 600, cursor: reprogramarBloqueado ? 'not-allowed' : 'pointer',
                opacity: reprogramarBloqueado ? 0.5 : 1, textDecoration: 'underline', textUnderlineOffset: '3px'
              }}
            >
              Reprogramar
            </button>
          )}
          {onCancelar && (
            <button
              type="button"
              onClick={onCancelar}
              style={{
                minHeight: '44px', padding: '4px 8px', background: 'transparent', border: 'none',
                color: 'var(--ek-danger)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                textDecoration: 'underline', textUnderlineOffset: '3px'
              }}
            >
              Cancelar
            </button>
          )}
        </div>
      ) : (
        <span style={{ flexShrink: 0 }}>
          <StatusBadge status={reserva.status} size={11} />
        </span>
      )}
    </div>
  );
}
