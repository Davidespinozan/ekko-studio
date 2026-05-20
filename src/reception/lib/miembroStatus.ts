/**
 * Etiqueta + color por estado de cuenta de un miembro (Sprint RP-2).
 * Estados reales: pendiente_onboarding · pendiente_pago · activo ·
 * suspendido · cancelado. Pura — reusada por la búsqueda y el perfil.
 */
export interface StatusMiembroInfo {
  label: string;
  color: string;
  /** true si el estado impide la operación normal (recepción debe avisar). */
  alerta: boolean;
}

export function statusMiembro(status: string): StatusMiembroInfo {
  switch (status) {
    case 'activo':
      return { label: 'Activo', color: 'var(--ek-success)', alerta: false };
    case 'suspendido':
      return { label: 'Suspendido', color: 'var(--ek-danger)', alerta: true };
    case 'cancelado':
      return { label: 'Cancelado', color: 'var(--ek-danger)', alerta: true };
    case 'pendiente_pago':
      return { label: 'Pendiente de pago', color: 'var(--ek-mustard)', alerta: true };
    case 'pendiente_onboarding':
      return { label: 'Pendiente de activación', color: 'var(--ek-mustard)', alerta: true };
    default:
      return { label: status, color: 'var(--ek-ink-muted)', alerta: true };
  }
}
