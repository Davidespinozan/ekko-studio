/**
 * ¿Desde cuándo una reserva confirmada sigue siendo "vigente" para el miembro?
 *
 * Las tres pantallas que muestran lo próximo (inicio, Mis reservas y el acceso
 * directo al QR) filtraban por `slot_inicio >= ahora`: en cuanto EMPEZABA la
 * sesión, la reserva —y con ella el QR— desaparecía de la app. Pero el check-in
 * sigue abierto hasta 30 min después de que TERMINA (check_in_atomic y qr-issue):
 * quien llegaba un minuto tarde abría la app, leía "No tienes una sesión próxima"
 * y no tenía cómo enseñar su QR, con la reserva todavía confirmada.
 *
 * Se filtra por `slot_fin` con esa misma gracia. Una vez hecho el check-in la
 * reserva pasa a `completada` y sale sola (las consultas piden `confirmada`).
 */
export const GRACIA_CHECKIN_MIN = 30;

/** Valor para `.gte('slot_fin', …)`. */
export function desdeReservasVigentesISO(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - GRACIA_CHECKIN_MIN * 60_000).toISOString();
}

/** La sesión ya empezó (y aún se puede hacer check-in). */
export function sesionEnCurso(slotInicio: string, ahora: Date = new Date()): boolean {
  return new Date(slotInicio).getTime() <= ahora.getTime();
}
