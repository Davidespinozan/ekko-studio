/**
 * Reparte las reservas del día en las tres bandas del panel "Hoy" de recepción.
 * Lógica PURA (sin React) para poder testearla.
 *
 *  - llegando:  CONFIRMADAS (sin check-in) cuyo horario está en curso o a punto
 *               de empezar (−15 min … fin, o +15 min tras el inicio). Solo si la
 *               fecha vista es hoy. Una cancelada/completada/no_show en esa
 *               ventana NO es "llegando": antes salían resaltadas como fantasmas.
 *  - faltantes: confirmadas cuyo horario ya pasó sin check-in (candidatas a
 *               no-show; el cron las resuelve, recepción no las marca aquí).
 *  - resto:     todo lo demás (próximas, completadas, canceladas, no-show).
 */

export interface ReservaClasificable {
  status: string;
  slot_inicio: string;
  slot_fin: string;
}

export interface ReservasClasificadas<T> {
  llegando: T[];
  resto: T[];
  faltantes: T[];
}

export const VENTANA_LLEGANDO_MS = 15 * 60_000;

export function clasificarReservasHoy<T extends ReservaClasificable>(
  reservas: readonly T[],
  opts: { esHoy: boolean; now?: number }
): ReservasClasificadas<T> {
  const now = opts.now ?? Date.now();
  const llegando: T[] = [];
  const resto: T[] = [];
  const faltantes: T[] = [];

  for (const r of reservas) {
    const inicio = new Date(r.slot_inicio).getTime();
    const fin = new Date(r.slot_fin).getTime();
    const enVentana =
      now >= inicio - VENTANA_LLEGANDO_MS && (now <= fin || now <= inicio + VENTANA_LLEGANDO_MS);
    const confirmada = r.status === 'confirmada';

    if (opts.esHoy && confirmada && enVentana) {
      llegando.push(r);
    } else if (opts.esHoy && confirmada && fin < now) {
      faltantes.push(r);
    } else {
      resto.push(r);
    }
  }

  return { llegando, resto, faltantes };
}
