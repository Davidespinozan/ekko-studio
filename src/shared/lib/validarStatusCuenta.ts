/**
 * Validación del estado de cuenta para la puerta de entrada (Sprint S1).
 *
 * Se usa ANTES del redirect en Login y como defensa profunda en
 * MemberLayout — un solo lugar para decidir si una cuenta puede entrar
 * y con qué mensaje.
 *
 * Estados reales (CHECK en migración 20260514100200_usuarios.sql):
 *   pendiente_onboarding · pendiente_pago · activo · suspendido · cancelado
 * `revocado` no está en el enum pero código admin lo usa — se maneja
 * defensivamente.
 *
 * NOTA: `bloqueado_hasta` (penalización por no-show) NO gatea el login.
 * Es una restricción de RESERVA: el miembro puede entrar, ver su cuenta
 * y el banner "RESTRICCIÓN ACTIVA" del Dashboard; solo no puede reservar.
 * Decisión de producto S1.
 */

export interface PerfilStatus {
  status: string;
}

export interface ResultadoValidacion {
  permitido: boolean;
  mensaje?: string;
}

export function validarStatusCuenta(perfil: PerfilStatus): ResultadoValidacion {
  switch (perfil.status) {
    case 'activo':
      return { permitido: true };

    case 'suspendido':
      return {
        permitido: false,
        mensaje: 'Tu cuenta está suspendida. Contactá al estudio para reactivarla.'
      };

    case 'revocado':
      return {
        permitido: false,
        mensaje: 'Tu acceso fue revocado. Si creés que es un error, contactá al estudio.'
      };

    case 'cancelado':
      return {
        permitido: false,
        mensaje: 'Tu cuenta fue cancelada. Contactá al estudio si querés reactivarla.'
      };

    case 'pendiente_onboarding':
      return {
        permitido: false,
        mensaje: 'Tu cuenta está pendiente de activación. Contactá al estudio.'
      };

    case 'pendiente_pago':
      return {
        permitido: false,
        mensaje: 'Tu cuenta está pendiente de pago. Contactá al estudio para activarla.'
      };

    default:
      // Status desconocido: bloquear defensivamente.
      console.error('[validarStatusCuenta] Status no válido:', perfil.status);
      return {
        permitido: false,
        mensaje: 'Tu cuenta tiene un estado no válido. Contactá al estudio.'
      };
  }
}

/**
 * Traduce un mensaje de error de Supabase Auth a copy human.
 * Nunca expone el mensaje técnico crudo al usuario.
 */
export function traducirErrorAuth(mensajeSupabase: string): string {
  const msg = mensajeSupabase.toLowerCase();

  if (msg.includes('invalid login credentials')) {
    return 'Email o contraseña incorrectos.';
  }
  if (msg.includes('email not confirmed')) {
    return 'Tu email no está confirmado. Revisá tu correo o contactá al estudio.';
  }
  if (msg.includes('too many requests') || msg.includes('rate limit')) {
    return 'Demasiados intentos. Esperá un momento e intentá de nuevo.';
  }
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to fetch')) {
    return 'Sin conexión. Verificá tu internet e intentá de nuevo.';
  }

  return 'No pudimos iniciar sesión. Intentá de nuevo o contactá al estudio.';
}
