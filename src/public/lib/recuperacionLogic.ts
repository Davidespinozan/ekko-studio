// ════════════════════════════════════════════════════════════════════════════
// Lógica PURA del flujo de contraseñas (recuperar / nueva / cambiar).
// Sin React ni red → testeable. La usan /recuperar, /nueva-contrasena, el
// CambiarPasswordForm (perfil + gate de clave temporal).
// ════════════════════════════════════════════════════════════════════════════

export type ResultadoValidacion = { ok: true } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validarEmail(email: string): ResultadoValidacion {
  const e = email.trim();
  if (!e) return { ok: false, error: 'Escribe tu email.' };
  if (!EMAIL_RE.test(e)) return { ok: false, error: 'El email no es válido.' };
  return { ok: true };
}

/** Misma regla en todos lados: mínimo 8 caracteres, con una letra y un número. */
export function validarPassword(password: string): ResultadoValidacion {
  if (password.length < 8) return { ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' };
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, error: 'Usa al menos una letra y un número.' };
  }
  return { ok: true };
}

/** Fuerza + coincidencia. */
export function validarNuevaContrasena(password: string, confirmacion: string): ResultadoValidacion {
  const fuerza = validarPassword(password);
  if (!fuerza.ok) return fuerza;
  if (password !== confirmacion) return { ok: false, error: 'Las contraseñas no coinciden.' };
  return { ok: true };
}

/**
 * Traduce errores de Supabase Auth a español claro. El caso clave es el enlace
 * expirado/inválido. Nunca se expone el mensaje crudo (inglés).
 */
export function traducirErrorRecuperacion(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('different from the old') || m.includes('should be different')) {
    return 'La nueva contraseña debe ser distinta de la anterior.';
  }
  if (m.includes('expired') || m.includes('invalid') || m.includes('not found') || (m.includes('session') && m.includes('missing'))) {
    return 'El enlace expiró o no es válido. Pide uno nuevo.';
  }
  if (m.includes('weak') || m.includes('at least')) return 'La contraseña no es lo bastante fuerte.';
  if (m.includes('too many') || m.includes('rate')) return 'Demasiados intentos. Espera unos minutos.';
  return 'No pudimos completar la acción. Intenta de nuevo.';
}
