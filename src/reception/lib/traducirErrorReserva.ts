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
    return 'No tienes permiso para esta acción.';
  }
  // En el mostrador se habla del MIEMBRO en tercera persona (el translator
  // compartido le habla al miembro: "No tienes un plan…").
  if (message.includes('EKKO_SIN_MEMBRESIA')) {
    return 'El miembro no tiene un plan vigente. Activa o renueva su plan antes de reservarle.';
  }
  if (message.includes('EKKO_MEMBRESIA_VENCIDA')) {
    return 'El plan del miembro venció. Renuévalo antes de reservarle.';
  }
  if (message.includes('EKKO_SIN_CREDITOS')) {
    return 'Al miembro no le alcanzan los créditos para este estudio.';
  }
  if (message.includes('EKKO_DURACION_INVALIDA')) {
    return 'La duración no es válida: entre 15 minutos y 8 horas, sin pasar de la medianoche.';
  }

  // Códigos compartidos (slot ocupado, reserva no cancelable, etc.).
  // `traducirErrorRPC` ya trae su propio fallback genérico (ERROR-UI-FIX
  // E-04): nunca devuelve el mensaje crudo del servidor, así que se puede
  // delegar directo sin el viejo chequeo `!== message`.
  return traducirErrorRPC(message);
}
