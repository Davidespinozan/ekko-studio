/**
 * R2-A (PKG-01M) · Errores de la guarda de planes (trigger tiers_proteger_semantica
 * y CHECK tiers_max_invitados_obligatorio) en palabras del admin. Lo demás pasa
 * tal cual (comportamiento previo de la pantalla de Planes).
 */
export function traducirErrorTier(message: string): string {
  if (message.includes('EKKO_TIER_SLUG_INMUTABLE')) {
    return 'El identificador (slug) de un plan no se puede cambiar. Crea un plan nuevo.';
  }
  if (message.includes('EKKO_TIER_EN_USO')) {
    const n = /EKKO_TIER_EN_USO:\s*(\d+)/.exec(message)?.[1];
    return `${n ? `${n} membresía(s) viva(s) usan` : 'Hay membresías vivas que usan'} este plan: no se puede desactivar ni cambiar su tipo. Para dejar de venderlo, apaga "en venta"; para otro tipo, crea un plan nuevo.`;
  }
  if (message.includes('tiers_max_invitados_obligatorio')) {
    return 'El plan necesita un número de invitados permitido (0 o más).';
  }
  return message;
}
