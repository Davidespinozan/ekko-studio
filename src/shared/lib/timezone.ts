// ============================================================================
// Zona horaria del estudio, centralizada. Antes cada métrica armaba los bordes
// de día/mes con la hora del NAVEGADOR → si el admin miraba desde otra zona,
// las cuentas se corrían un día en los bordes de mes. Acá todo se calcula en la
// zona del estudio.
//
// Culiacán, Sinaloa → America/Mazatlan (UTC-7 fijo; México ya no aplica horario
// de verano). Implementado con Intl (sin dependencias). Robusto ante DST.
// ============================================================================

export const ZONA_ESTUDIO = 'America/Mazatlan';

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Offset de la zona (en minutos, local − UTC) para un instante dado. */
function offsetMin(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const p = dtf.formatToParts(instant).reduce((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {} as Record<string, string>);
  const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asIfUTC - instant.getTime()) / 60000;
}

export interface PartesFecha {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  dow: number; // día de semana, 0=domingo … 6=sábado (como getDay)
}

/** Componentes de un instante EN la zona del estudio (para agrupar por día/hora). */
export function partesEnZona(instant: Date, tz: string = ZONA_ESTUDIO): PartesFecha {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short'
  });
  const p = dtf.formatToParts(instant).reduce((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {} as Record<string, string>);
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    dow: DOW[p.weekday] ?? 0
  };
}

/**
 * Instante UTC que corresponde a una hora de pared (por defecto 00:00) de una
 * fecha en la zona del estudio. Ej: 1 de julio 00:00 en Mazatlan → 07:00 UTC.
 */
export function instanteEnZona(
  year: number,
  month0: number, // 0–11
  day: number,
  hour = 0,
  min = 0,
  tz: string = ZONA_ESTUDIO
): Date {
  const wallUTC = Date.UTC(year, month0, day, hour, min, 0);
  const off = offsetMin(new Date(wallUTC), tz);
  return new Date(wallUTC - off * 60000);
}

/** Inicio del día de HOY (00:00) en la zona del estudio, como instante UTC. */
export function inicioDeHoyEnZona(now: Date = new Date(), tz: string = ZONA_ESTUDIO): Date {
  const { year, month, day } = partesEnZona(now, tz);
  return instanteEnZona(year, month - 1, day, 0, 0, tz);
}

/**
 * Inicio del mes (día 1, 00:00) en la zona del estudio, como instante UTC.
 * @param offsetMeses 0 = mes actual, -1 = mes anterior, etc.
 */
export function inicioDeMesEnZona(offsetMeses = 0, now: Date = new Date(), tz: string = ZONA_ESTUDIO): Date {
  const { year, month } = partesEnZona(now, tz);
  return instanteEnZona(year, month - 1 + offsetMeses, 1, 0, 0, tz);
}
