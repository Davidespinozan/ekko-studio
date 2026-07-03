// ============================================================================
// Utilidades de WhatsApp (canal principal en México). Normaliza un teléfono al
// formato que espera wa.me: código de país + número, solo dígitos.
// ============================================================================

/**
 * Normaliza un teléfono mexicano al formato wa.me (52 + 10 dígitos).
 * Acepta con/sin lada, espacios, guiones o +. Devuelve null si no es usable.
 */
export function telWhatsAppMx(tel: string | null | undefined): string | null {
  if (!tel) return null;
  const d = tel.replace(/\D/g, '');
  if (d.length === 10) return `52${d}`; // 10 dígitos locales → prefijo país
  if (d.length === 12 && d.startsWith('52')) return d; // ya trae 52
  if (d.length === 13 && d.startsWith('521')) return `52${d.slice(3)}`; // 521… legado → 52…
  return d.length >= 10 ? d : null; // otro país u otro largo: usar tal cual
}

/** Arma el enlace wa.me con un mensaje pre-cargado (ya URL-encoded). */
export function waLink(telNormalizado: string, mensaje: string): string {
  return `https://wa.me/${telNormalizado}?text=${encodeURIComponent(mensaje)}`;
}
