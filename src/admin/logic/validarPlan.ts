/**
 * Validación del formulario de planes (crear Y editar), espejo de los CHECK de
 * `tiers` (migración 20260920140000_tiers_checks).
 *
 * El caso que motiva esto: `parseInt('') || 0` dejaba guardar un paquete con
 * vigencia de 0 días. Ese paquete nace vencido — el miembro paga y el siguiente
 * cron le pone los créditos en cero.
 */
export interface PlanDraft {
  nombre: string;
  precioCentavos: number;
  /** Paquete de créditos (vs. membresía por tiempo). */
  esPaquete: boolean;
  /** El paquete tiene vigencia (híbrido) o sus créditos no caducan. */
  vence: boolean;
  clasesIncluidas: number;
  duracionDias: number;
}

/** Devuelve el mensaje de error para mostrar, o `null` si el plan es válido. */
export function validarPlan(p: PlanDraft): string | null {
  if (!p.nombre.trim()) return 'El nombre es obligatorio.';
  if (!Number.isFinite(p.precioCentavos) || p.precioCentavos < 0) return 'Precio inválido.';

  if (p.esPaquete) {
    if (!Number.isInteger(p.clasesIncluidas) || p.clasesIncluidas < 1) {
      return 'El paquete debe incluir al menos 1 sesión.';
    }
    if (p.vence && (!Number.isInteger(p.duracionDias) || p.duracionDias < 1)) {
      return 'La vigencia debe ser de al menos 1 día.';
    }
  }
  return null;
}
