import { traducirErrorRPC } from '@member/logic/reservaLogic';

/**
 * Traduce errores de los RPCs de reserva a mensajes claros para recepción
 * (Sprint RP-3a). Cubre los códigos nuevos de `reservar_para_miembro_atomic`
 * (RP-1) y delega el resto a `traducirErrorRPC` — el translator compartido —
 * sin duplicar ni tocar código del módulo miembro.
 *
 * Nunca expone el mensaje técnico crudo.
 */
export function traducirErrorReserva(message: string): string {
  if (message.includes('EKKO_MIEMBRO_NO_ACTIVO')) {
    return 'El miembro no está activo. Derivá al cliente con administración.';
  }
  if (message.includes('EKKO_MIEMBRO_INVALIDO')) {
    return 'Miembro no válido o de otro estudio.';
  }
  if (message.includes('EKKO_MIEMBRO_BLOQUEADO')) {
    return 'El miembro tiene una restricción activa por inasistencia.';
  }
  if (message.includes('EKKO_NO_AUTORIZADO')) {
    return 'No tenés permiso para esta acción.';
  }

  // Códigos compartidos (slot ocupado, reserva no cancelable, etc.).
  // `traducirErrorRPC` ya trae su propio fallback genérico (ERROR-UI-FIX
  // E-04): nunca devuelve el mensaje crudo del servidor, así que se puede
  // delegar directo sin el viejo chequeo `!== message`.
  return traducirErrorRPC(message);
}
