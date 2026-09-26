import { Unlock } from 'lucide-react';
import { statusMiembro } from '../../lib/miembroStatus';
import { fechaCorta } from './perfilUtils';
import type { MiembroPerfil } from './types';

/** Qué significa cada status de CUENTA para quien atiende, y qué hacer. */
function explicacion(status: string): string {
  switch (status) {
    case 'pendiente_pago':
    case 'pendiente_onboarding':
      return 'Todavía no tiene un plan pagado. Asígnale uno en Membresía (arriba) cuando confirmes el pago.';
    case 'cancelado':
      return 'Se dio de baja. Puede volver cuando quiera: asígnale un plan en Membresía (arriba).';
    case 'suspendido':
      return 'La administración suspendió esta cuenta: no puede entrar ni reservar. Solo un admin la reactiva.';
    case 'revocado':
      return 'La administración revocó el acceso de esta cuenta.';
    default:
      return 'La cuenta no está activa. Consulta con administración.';
  }
}

/**
 * Aviso de estado de CUENTA (solo si hay algo que atender): cuenta no activa o
 * bloqueo por inasistencia.
 *
 * Ya NO ofrece "Activar membresía": eso dependía del status de la cuenta y por
 * eso un miembro en pausa veía "Activar" y uno activo sin créditos no veía nada.
 * El plan se gestiona en `MembresiaCard`, que decide por el estado de la
 * membresía. Una cuenta `suspendido` POR LA PAUSA no es una sanción: no se
 * muestra aquí (la tarjeta de membresía ya dice "En pausa" y ofrece "Reanudar").
 */
export function EstadoCuentaCard({
  miembro,
  enPausa = false,
  onDesbloquear
}: {
  miembro: MiembroPerfil;
  enPausa?: boolean;
  onDesbloquear: () => void;
}) {
  const st = statusMiembro(miembro.status);
  const bloqueado =
    miembro.bloqueado_hasta != null && new Date(miembro.bloqueado_hasta).getTime() > Date.now();
  const cuentaConAviso = st.alerta && !(enPausa && miembro.status === 'suspendido');

  if (!cuentaConAviso && !bloqueado) return null;

  const color = cuentaConAviso ? st.color : 'var(--ek-mustard)';

  return (
    <div className="ek-card" style={{ borderColor: color, borderLeft: `3px solid ${color}`, marginBottom: '16px' }}>
      {cuentaConAviso && (
        <>
          <p style={{ fontSize: '13px', fontWeight: 600, color: st.color, margin: 0 }}>Cuenta: {st.label}</p>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 0', lineHeight: 1.45 }}>
            {explicacion(miembro.status)}
          </p>
        </>
      )}

      {bloqueado && (
        <div style={{ marginTop: cuentaConAviso ? '12px' : 0 }}>
          {!cuentaConAviso && (
            <p style={{ fontSize: '13px', fontWeight: 600, color, margin: 0 }}>Restricción por inasistencia</p>
          )}
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
        </div>
      )}
    </div>
  );
}
