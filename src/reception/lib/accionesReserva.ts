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
