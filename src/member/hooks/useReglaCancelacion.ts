import { useTenant } from '@shared/hooks/useTenant';

/**
 * Hook para la regla de tiempo mínimo de cancelación del tenant.
 *
 * Lee `tenant.config.reserva.cancelacion_min_horas_antes` (pattern jsonb del
 * resto de reglas operativas). Si no está configurada, 24.
 *
 * R2-B (PKG-01Q): este hook REPRESENTA la regla del servidor, no la define. La
 * fuente es `_cancelacion_min_horas` (SQL): misma clave, mismo default (24) y la
 * misma frontera (`_cancelacion_tardia`): a tiempo si faltan MÁS de N horas;
 * tarde si faltan N o menos. Antes aquí el default era 0 y en la pantalla de
 * Reglas 24.
 */
export const CANCELACION_HORAS_DEFAULT = 24;

export function useReglaCancelacion(): { cancelacionMinHorasAntes: number } {
  const tenant = useTenant();
  const config = (tenant.config ?? {}) as Record<string, unknown>;
  const reserva = (config.reserva ?? {}) as Record<string, unknown>;
  const raw = reserva.cancelacion_min_horas_antes;

  let horas = CANCELACION_HORAS_DEFAULT;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    horas = raw;
  } else if (typeof raw === 'string') {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) horas = parsed;
  }

  return { cancelacionMinHorasAntes: horas };
}

export interface PuedeCancelarResult {
  puede: boolean;
  razon?: string;
  horasRestantes: number;
}

/**
 * Determina si una reserva puede cancelarse en este momento.
 * Considera la hora actual + slot_inicio + regla del tenant.
 *
 * - Reserva pasada → false ("Esta reserva ya pasó")
 * - Regla 0 → siempre se puede (hasta el último minuto)
 * - Horas restantes <= regla → false ("Faltan N horas o menos"): la igualdad
 *   exacta ya es tarde, igual que en el servidor.
 */
export function puedeCancelarReserva(
  slotInicio: string | Date,
  minHorasAntes: number
): PuedeCancelarResult {
  const inicio = slotInicio instanceof Date ? slotInicio : new Date(slotInicio);
  const ahora = new Date();
  const diffMs = inicio.getTime() - ahora.getTime();
  const horasRestantes = diffMs / 3_600_000;

  if (horasRestantes <= 0) {
    return { puede: false, razon: 'Esta reserva ya pasó', horasRestantes };
  }
  if (minHorasAntes <= 0) {
    return { puede: true, horasRestantes };
  }
  if (horasRestantes <= minHorasAntes) {
    return {
      puede: false,
      razon: `Faltan ${minHorasAntes} horas o menos`,
      horasRestantes
    };
  }
  return { puede: true, horasRestantes };
}
