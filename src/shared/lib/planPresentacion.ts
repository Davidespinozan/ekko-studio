// ============================================================================
// Presentación de un plan al miembro, consistente en todas las superficies
// (signup, MiSuscripcion, pago). Un plan mensual se cobra "/mes"; un paquete de
// créditos es un cobro único de N sesiones. Antes cada pantalla lo resolvía por
// su cuenta (varias hardcodeaban "/mes" aunque fuera paquete) → esto lo unifica.
// ============================================================================

export interface TierPresentable {
  tipo?: string | null; // 'tiempo' | 'creditos' | 'hibrido'
  clases_incluidas?: number | null;
  duracion_dias?: number | null;
}

/** ¿Es un paquete de créditos (cobro único) en vez de una mensualidad? */
export function esPlanPaquete(tier: Pick<TierPresentable, 'tipo'>): boolean {
  return tier.tipo === 'creditos' || tier.tipo === 'hibrido';
}

/** Sufijo que va junto al precio: "/mes" (mensual) o " · pago único" (paquete). */
export function sufijoPrecio(tier: Pick<TierPresentable, 'tipo'>): string {
  return esPlanPaquete(tier) ? ' · pago único' : '/mes';
}

/**
 * Sufijo del precio EN EL LANDING (junto al número grande):
 * "/mes" (mensual) · " · N sesiones" (paquete con cupo) · " · paquete" (sin cupo).
 * Se distingue de sufijoPrecio porque el landing muestra el número de sesiones.
 */
export function sufijoPrecioSesiones(tier: TierPresentable): string {
  if (!esPlanPaquete(tier)) return '/mes';
  const n = tier.clases_incluidas ?? 0;
  if (!n) return ' · paquete';
  return ` · ${n} ${n === 1 ? 'sesión' : 'sesiones'}`;
}

/**
 * ¿El plan está marcado como recomendado (destacado en el landing)? Lo controla
 * el admin con el flag reglas.recomendado — no un slug fijo.
 */
export function esTierRecomendado(reglas: Record<string, unknown> | null | undefined): boolean {
  return reglas?.recomendado === true;
}

/** Qué incluye el plan, en una línea (para mostrar bajo el precio). */
export function detallePlan(tier: TierPresentable): string {
  if (!esPlanPaquete(tier)) return 'Acceso mensual ilimitado';
  const n = tier.clases_incluidas ?? 0;
  const sesiones = `${n} ${n === 1 ? 'sesión' : 'sesiones'}`;
  if (tier.tipo === 'hibrido' && tier.duracion_dias) {
    return `${sesiones} · vencen en ${tier.duracion_dias} días`;
  }
  return `${sesiones} · sin vencimiento`;
}
