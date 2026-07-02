// ============================================================================
// agruparReservas — agrupa una lista de reservas por día calendario para
// pintarlas en secciones ("Hoy", "Mañana", "lunes 7 de julio"). Pura para
// poder testearla sin montar la página. Preserva el orden de entrada.
// ============================================================================

export interface ConSlot {
  slot_inicio: string;
}

export interface GrupoDia<T> {
  /** Clave estable del día (YYYY-M-D en hora local). */
  key: string;
  /** Etiqueta legible: "Hoy", "Mañana", "Ayer" o fecha larga. */
  label: string;
  items: T[];
}

function claveDia(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Diferencia en días calendario (local) entre dos fechas: b - a. */
function difDias(a: Date, b: Date): number {
  const ma = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const mb = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((mb - ma) / 86_400_000);
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function etiquetaDia(fecha: Date, ahora: Date): string {
  const diff = difDias(ahora, fecha);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  return capitalizar(
    fecha.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
  );
}

/**
 * Agrupa `items` (ya ordenados) por día calendario. `ahora` es inyectable para
 * tests; default `new Date()`. Reservas con `slot_inicio` inválido se ignoran.
 */
export function agruparPorDia<T extends ConSlot>(items: T[], ahora: Date = new Date()): GrupoDia<T>[] {
  const grupos: GrupoDia<T>[] = [];
  const porKey = new Map<string, GrupoDia<T>>();

  for (const item of items) {
    const fecha = new Date(item.slot_inicio);
    if (Number.isNaN(fecha.getTime())) continue;
    const key = claveDia(fecha);
    let grupo = porKey.get(key);
    if (!grupo) {
      grupo = { key, label: etiquetaDia(fecha, ahora), items: [] };
      porKey.set(key, grupo);
      grupos.push(grupo);
    }
    grupo.items.push(item);
  }

  return grupos;
}
