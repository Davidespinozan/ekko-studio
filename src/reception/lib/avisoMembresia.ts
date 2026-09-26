/**
 * Aviso para recepción según el `membresia_estado` que devuelven los RPC de
 * check-in: 'ok' | 'sin_membresia' | 'vencida' | 'pago_pendiente' | 'cuenta_*'.
 *
 * El check-in MANUAL no bloquea por membresía (decisión: "QR bloquea, manual
 * avisa"), así que este texto es la única barrera: todo camino de check-in
 * manual —el detalle de Hoy y el walk-in— tiene que mostrarlo.
 */
const AVISOS: Record<string, string> = {
  sin_membresia: 'Sin membresía vigente: cobra o activa un plan antes de dejarlo grabar.',
  vencida: 'Membresía VENCIDA: renovar antes de dejarlo grabar.',
  pago_pendiente:
    'Pago PENDIENTE (la tarjeta rechazó el cobro): pídele que actualice su tarjeta o cobra en mostrador.'
};

/** `null` = membresía en regla (o estado no informado): no hay nada que avisar. */
export function avisoMembresia(estado: string | null | undefined): string | null {
  if (!estado || estado === 'ok') return null;
  if (AVISOS[estado]) return AVISOS[estado];
  if (estado.startsWith('cuenta_')) {
    return `Cuenta ${estado.replace('cuenta_', '')}: el miembro no debería poder entrar; revisa con administración.`;
  }
  return 'La membresía no está vigente; revisa antes de dejarlo grabar.';
}
