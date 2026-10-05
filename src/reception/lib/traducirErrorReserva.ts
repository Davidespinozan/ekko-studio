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

  // R2-B (PKG-01O): en el mostrador se habla del miembro en tercera persona.
  if (message.includes('EKKO_FUERA_DE_VIGENCIA')) {
    const fecha = /termina el (\d{2}\/\d{2}\/\d{4})/.exec(message)?.[1];
    return `La membresía del miembro termina${fecha ? ` el ${fecha}` : ''}: no se puede reservar después de esa fecha. Renueva su plan primero.`;
  }

  // R2-A (PKG-01J) · reprogramación atómica.
  if (message.includes('EKKO_REPROGRAMAR_NO_VIGENTE')) {
    return 'Solo se reprograma una reserva confirmada.';
  }
  if (message.includes('EKKO_REPROGRAMAR_PASADA')) {
    return 'Esa sesión ya empezó; no se puede reprogramar.';
  }
  if (message.includes('EKKO_MISMO_HORARIO')) {
    return 'Ese es el horario actual de la reserva. Elige uno distinto.';
  }
  if (message.includes('EKKO_EXTRAS_EXCEDEN_TOPE')) {
    return 'La reserva tiene invitados extra pagados y ese estudio admite menos. Elige otro estudio.';
  }
  if (message.includes('EKKO_FICHAS_EXCEDEN')) {
    return 'La reserva ya tiene más invitados registrados de los que cubriría la nueva. Ajusta los invitados.';
  }
  if (message.includes('EKKO_EXTRAS_INCONSISTENTES')) {
    return 'Los invitados extra pagados de esta reserva no cuadran con sus pagos. Pide a administración que lo revise antes de reprogramar.';
  }

  // Códigos compartidos (slot ocupado, reserva no cancelable, etc.).
  // `traducirErrorRPC` ya trae su propio fallback genérico (ERROR-UI-FIX
  // E-04): nunca devuelve el mensaje crudo del servidor, así que se puede
  // delegar directo sin el viejo chequeo `!== message`.
  return traducirErrorRPC(message);
}
