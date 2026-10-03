import { backendPost } from '@shared/lib/backend';

/**
 * Acciones de front-desk sobre una RESERVA (Bloque D). Pasan por Netlify
 * functions con service_role que validan rol recepcionista/admin + tenant,
 * exigen motivo y registran en audit_log (mismo patrón que Bloque A).
 */

export interface NoShowResult {
  success: boolean;
  status: string;
  no_shows_count: number;
  bloqueado_hasta: string | null;
}

export function marcarNoShow(reserva_id: string, motivo: string): Promise<NoShowResult> {
  return backendPost<NoShowResult>('reception-marcar-no-show', { reserva_id, motivo });
}

export interface CorregirResult {
  success: boolean;
  status: string;
}

export function corregirCheckin(reserva_id: string, motivo: string): Promise<CorregirResult> {
  return backendPost<CorregirResult>('reception-corregir-checkin', { reserva_id, motivo });
}

export interface AsistioResult {
  success: boolean;
  status: string;
  penalizacion: { no_shows_count: number; bloqueado_hasta: string | null } | null;
}

/** "Sí asistió": corrige un no_show ya iniciado → completada (revierte la falta). R2-A: una cancelada no se revive. */
export function marcarAsistio(reserva_id: string, motivo: string): Promise<AsistioResult> {
  return backendPost<AsistioResult>('reception-marcar-asistio', { reserva_id, motivo });
}

/**
 * R2-A (PKG-01I): "sí asistió" corrige SOLO un no_show ya iniciado. Una reserva
 * cancelada ya devolvió su crédito y liberó el horario: no se revive (el servidor
 * lo rechaza); si el miembro sí usó el estudio, se le crea una reserva nueva.
 */
export function esCorregibleAsistencia(r: { status: string; slot_inicio: string }, ahora: Date = new Date()): boolean {
  return r.status === 'no_show' && new Date(r.slot_inicio).getTime() <= ahora.getTime();
}

// Motivos predefinidos (Bloque D). David puede ajustarlos.
export const MOTIVOS_NO_SHOW = [
  'Cliente no se presentó',
  'Cliente avisó tarde / fuera de política',
  'Doble-reserva del cliente (ya estaba en otra)'
];

export const MOTIVOS_CORREGIR_CHECKIN = [
  'Check-in al miembro equivocado',
  'El miembro no llegó a presentarse físicamente',
  'Error operativo de recepción'
];

export const MOTIVOS_ASISTIO = [
  'Sí vino, no le hicieron check-in',
  'El cron lo marcó no-show por error'
];
