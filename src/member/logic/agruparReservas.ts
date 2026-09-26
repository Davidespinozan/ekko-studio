// ============================================================================
// agruparReservas — agrupa una lista de reservas por día calendario para
// pintarlas en secciones ("Hoy", "Mañana", "lunes 7 de julio"). Pura para
// poder testearla sin montar la página. Preserva el orden de entrada.
//
// El "día" es el del ESTUDIO, no el del teléfono: una sesión a las 23:00 de
// Mazatlán es "hoy" aunque quien la mira esté en CDMX (donde ya es mañana). Antes
// se agrupaba con el reloj del navegador y la misma reserva cambiaba de día —y de
// hora— según la pantalla.
// ============================================================================

import { fechaISOEnZona, diasEntreISO, formatFechaEnZona } from '@shared/lib/timezone';

export interface ConSlot {
  slot_inicio: string;
}

export interface GrupoDia<T> {
  /** Clave estable del día (YYYY-MM-DD en la zona del estudio). */
  key: string;
  /** Etiqueta legible: "Hoy", "Mañana", "Ayer" o fecha larga. */
  label: string;
  items: T[];
}

function claveDia(d: Date): string {
  return fechaISOEnZona(d);
}

/** Diferencia en días calendario (del estudio) entre dos instantes: b - a. */
function difDias(a: Date, b: Date): number {
  return diasEntreISO(fechaISOEnZona(a), fechaISOEnZona(b));
}

function capitalizar(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function etiquetaDia(fecha: Date, ahora: Date): string {
  const diff = difDias(ahora, fecha);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  return capitalizar(formatFechaEnZona(fecha, { weekday: 'long', day: 'numeric', month: 'long' }));
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
