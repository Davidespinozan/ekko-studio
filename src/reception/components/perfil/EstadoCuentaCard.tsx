import { Unlock } from 'lucide-react';
import { statusMiembro } from '../../lib/miembroStatus';
import { fechaCorta } from './perfilUtils';
import type { MiembroPerfil } from './types';

/**
 * Aviso de estado de cuenta (solo si hay algo que atender): cuenta no activa o
 * bloqueo por inasistencia. Recepción lo usa para explicárselo al cliente y
 * actuar (activar membresía / desbloquear).
 */
export function EstadoCuentaCard({
  miembro,
  activando,
  onActivar,
  onDesbloquear
}: {
  miembro: MiembroPerfil;
  activando: boolean;
  onActivar: () => void;
  onDesbloquear: () => void;
}) {
  const st = statusMiembro(miembro.status);
  const bloqueado =
    miembro.bloqueado_hasta != null && new Date(miembro.bloqueado_hasta).getTime() > Date.now();

  if (!st.alerta && !bloqueado) return null;

  return (
    <div
      className="ek-card"
      style={{ borderColor: st.color, borderLeft: `3px solid ${st.color}`, marginBottom: '16px' }}
    >
      <p style={{ fontSize: '13px', fontWeight: 600, color: st.color, margin: 0 }}>{st.label}</p>

      {miembro.status !== 'activo' && (
        <>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 8px' }}>
            La cuenta no está activa. Confirma el pago y activa la membresía
            {miembro.membresia_tier ? '' : ' (asigná un plan primero en "Editar datos")'}.
          </p>
          <button
            type="button"
            onClick={onActivar}
            disabled={activando || !miembro.membresia_tier}
            className="ek-cta ek-cta--gold"
            style={{
              minHeight: '40px',
              padding: '8px 14px',
              fontSize: '13px',
              opacity: !miembro.membresia_tier ? 0.5 : 1,
              cursor: !miembro.membresia_tier ? 'not-allowed' : 'pointer'
            }}
          >
            {activando ? 'Activando…' : 'Activar membresía'}
          </button>
        </>
      )}

      {bloqueado && (
        <>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 8px' }}>
            Restricción para reservar hasta el {fechaCorta(miembro.bloqueado_hasta as string)}{' '}
            (penalización por inasistencia).
          </p>
          <button
            type="button"
            onClick={onDesbloquear}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '40px', padding: '8px 14px', fontSize: '13px' }}
          >
            <Unlock size={15} aria-hidden="true" /> Desbloquear ahora
          </button>
        </>
      )}
    </div>
  );
}
