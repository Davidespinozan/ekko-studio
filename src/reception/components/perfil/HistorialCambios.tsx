import { fechaHora } from './perfilUtils';
import type { AuditEntryUsuario } from '../../hooks/useAuditLogDeUsuario';

function actorLabel(rol: string | null): string {
  if (rol === 'admin') return 'Admin';
  if (rol === 'recepcionista') return 'Recepción';
  return rol ?? '—';
}

function valorTexto(v: unknown): string {
  if (v == null || v === '') return '—';
  return String(v);
}

function planLabel(v: unknown): string {
  return v == null ? 'sin plan' : String(v);
}

function describirCambio(e: AuditEntryUsuario): string {
  switch (e.accion) {
    case 'status_change':
      return `Cambió estado: ${valorTexto(e.antes?.status)} → ${valorTexto(e.despues?.status)}`;
    case 'tier_change':
      return `Cambió plan: ${planLabel(e.antes?.membresia_tier)} → ${planLabel(e.despues?.membresia_tier)}`;
    case 'unblock':
      return 'Levantó el bloqueo por inasistencia';
    case 'no_show_manual':
      return 'Marcó inasistencia (no-show)';
    case 'checkin_correction':
      return 'Corrigió un check-in';
    case 'contact_change':
      return 'Editó datos de contacto';
    case 'avatar_change':
      return 'Actualizó la foto';
    case 'password_reset':
      return 'Reseteó el acceso';
    case 'create_member':
      return 'Registró al miembro';
    case 'membership_activated':
      return `Activó el plan: ${planLabel(e.despues?.membresia_tier)}`;
    case 'membresia_pausada':
      return 'Pausó la membresía';
    case 'membresia_reactivada':
      return 'Reanudó la membresía';
    case 'membresia_baja':
      return e.despues?.cancel_at_period_end ? 'Dio de baja la membresía (no se renovará)' : 'Dio de baja la membresía';
    case 'creditos_ajustados':
      return `Ajustó créditos: ${valorTexto(e.antes?.creditos_restantes)} → ${valorTexto(e.despues?.creditos_restantes)}`;
    case 'reserva_cancelada_por_estudio':
      return 'Canceló una reserva del miembro';
    case 'asistencia_correction':
      return 'Corrigió una asistencia';
    case 'ficha_identidad_actualizada':
      return 'Actualizó la ficha de identidad';
    case 'notification_sent': // histórico anterior a PKG-03A
    case 'aviso_registrado':
      return 'Le dejó un aviso';
    case 'invitado_agregado':
      return 'Registró un invitado';
    case 'invitado_eliminado':
      return 'Quitó un invitado';
    case 'material_subido':
      return `Subió material: ${valorTexto(e.despues?.titulo)}`;
    case 'material_retirado':
      return `Retiró material: ${valorTexto(e.antes?.titulo)}`;
    case 'reserva_observacion':
      return 'Anotó una observación en una reserva';
    case 'cuenta_estado_cambio':
      return `Estado de cuenta: ${valorTexto(e.antes?.status)} → ${valorTexto(e.despues?.status)}`;
    case 'membresia_estado_cambio':
      return e.antes
        ? `Membresía: ${valorTexto(e.antes?.membresia_status)} → ${valorTexto(e.despues?.membresia_status)}`
        : `Membresía nueva: ${valorTexto(e.despues?.tier)}`;
    case 'checkin_manual_con_restriccion':
      return `Ingreso manual con restricción (${valorTexto(e.despues?.membresia_estado)})`;
    case 'stripe_estado_contradictorio':
      return 'Stripe reportó una suscripción viva sobre una membresía cerrada (sin cambios)';
    case 'acceso_restaurado':
      return 'Restauró un acceso revocado';
    // PKG-06A: operaciones de cuenta con actor explícito.
    case 'cuenta_creada':
      return `Creó la cuenta (${valorTexto(e.despues?.rol)})`;
    case 'acceso_creado':
      return 'Creó el acceso a un perfil existente';
    case 'acceso_autorizado':
      return 'Autorizó crear el acceso sobre este perfil';
    case 'auth_vinculado':
      return 'Vinculó el acceso al perfil';
    case 'rol_cambiado':
      return `Cambió rol: ${valorTexto(e.antes?.rol)} → ${valorTexto(e.despues?.rol)}`;
    case 'cuenta_eliminada':
      return 'Eliminó la cuenta (sin historial)';
    default:
      // Una acción nueva sin etiqueta: legible, nunca el identificador crudo.
      return e.accion.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

/** Bitácora de cambios de cuenta del miembro (audit_log). */
export function HistorialCambios({
  entries,
  isLoading,
  error
}: {
  entries: AuditEntryUsuario[];
  isLoading: boolean;
  error: boolean;
}) {
  if (isLoading) {
    return <div className="ek-skeleton" style={{ height: '48px', borderRadius: 'var(--ek-r-sm)' }} />;
  }
  if (error) {
    return <p className="ek-body-faint">No se pudo cargar el historial.</p>;
  }
  if (entries.length === 0) {
    return <p className="ek-body-faint">Sin cambios registrados.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {entries.map((e) => (
        <div
          key={e.id}
          style={{
            padding: '10px 14px',
            background: 'var(--ek-bg-soft)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-sm)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--ek-ink)', fontWeight: 600 }}>{describirCambio(e)}</span>
            <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {fechaHora(e.creada_at)}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '2px' }}>{actorLabel(e.actor_rol)}</div>
          {e.motivo && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '6px 0 0', fontStyle: 'italic' }}>
              "{e.motivo}"
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
