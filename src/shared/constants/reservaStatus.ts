/**
 * Estados de reserva — fuente única de verdad para filtros de UI.
 *
 * Status posibles en BD (reservas.status):
 *   - 'confirmada'        — reservada, espera check-in
 *   - 'completada'        — check-in hecho
 *   - 'no_show'           — pasó la hora sin check-in
 *   - 'cancelada'         — cancelada por el miembro
 *   - 'cancelada_admin'   — cancelada por admin del tenant (Sprint Final)
 *
 * Reglas de visibilidad:
 *   - Dashboard / próximas reservas → SOLO confirmada (futura)
 *   - Perfil / historial            → completada, no_show, cancelada, cancelada_admin
 *   - QR emitible (qr-issue)        → SOLO confirmada
 */

export const ESTADOS_RESERVA_ACTIVOS = ['confirmada'] as const;

export const ESTADOS_RESERVA_HISTORICOS = [
  'completada',
  'no_show',
  'cancelada',
  'cancelada_admin'
] as const;

export const ESTADOS_RESERVA_CANCELADAS = ['cancelada', 'cancelada_admin'] as const;

export type EstadoReserva = (typeof ESTADOS_RESERVA_ACTIVOS)[number]
  | (typeof ESTADOS_RESERVA_HISTORICOS)[number];

export function esEstadoActivo(s: string): boolean {
  return (ESTADOS_RESERVA_ACTIVOS as readonly string[]).includes(s);
}

export function esEstadoHistorico(s: string): boolean {
  return (ESTADOS_RESERVA_HISTORICOS as readonly string[]).includes(s);
}

export function esEstadoCancelado(s: string): boolean {
  return (ESTADOS_RESERVA_CANCELADAS as readonly string[]).includes(s);
}
