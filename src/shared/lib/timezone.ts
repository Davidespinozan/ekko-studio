// ============================================================================
// Zona horaria del estudio, centralizada. Antes cada métrica armaba los bordes
// de día/mes con la hora del NAVEGADOR → si el admin miraba desde otra zona,
// las cuentas se corrían un día en los bordes de mes. Aquí todo se calcula en la
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

// ── Fechas de calendario ('YYYY-MM-DD') en la zona del estudio ───────────────
// La UI (recepción, reservas, reportes) piensa en "días del estudio", no en
// días del navegador. Estos helpers convierten instante ↔ fecha de calendario
// SIEMPRE en ZONA_ESTUDIO, y formatean horas/fechas en esa zona.

const pad2 = (n: number) => String(n).padStart(2, '0');

export interface FechaISOPartes {
  year: number;
  month0: number; // 0–11
  day: number;
}

export function parseFechaISO(fechaISO: string): FechaISOPartes {
  const [y, m, d] = fechaISO.split('-').map(Number);
  return { year: y, month0: (m ?? 1) - 1, day: d ?? 1 };
}

/** 'YYYY-MM-DD' del día en que cae un instante, en la zona del estudio. */
export function fechaISOEnZona(instant: Date | string, tz: string = ZONA_ESTUDIO): string {
  const { year, month, day } = partesEnZona(new Date(instant), tz);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 'YYYY-MM-DD' de HOY en la zona del estudio. */
export function hoyISOEnZona(now: Date = new Date(), tz: string = ZONA_ESTUDIO): string {
  return fechaISOEnZona(now, tz);
}

/** Suma días a una fecha de calendario (sin tocar zonas: aritmética UTC pura). */
export function sumarDiasISO(fechaISO: string, dias: number): string {
  const { year, month0, day } = parseFechaISO(fechaISO);
  const d = new Date(Date.UTC(year, month0, day + dias));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Días de calendario entre dos fechas ISO (b − a). */
export function diasEntreISO(a: string, b: string): number {
  const pa = parseFechaISO(a);
  const pb = parseFechaISO(b);
  return Math.round((Date.UTC(pb.year, pb.month0, pb.day) - Date.UTC(pa.year, pa.month0, pa.day)) / 86400000);
}

/** Día de la semana (0=domingo … 6=sábado) de una fecha de calendario. */
export function diaSemanaDeFechaISO(fechaISO: string): number {
  const { year, month0, day } = parseFechaISO(fechaISO);
  return new Date(Date.UTC(year, month0, day)).getUTCDay();
}

/** Instante UTC de una hora de pared 'HH:mm' de una fecha ISO en la zona del estudio. */
export function instanteDeFechaHoraEnZona(fechaISO: string, horaHHmm = '00:00', tz: string = ZONA_ESTUDIO): Date {
  const { year, month0, day } = parseFechaISO(fechaISO);
  const [h, min] = horaHHmm.split(':').map(Number);
  return instanteEnZona(year, month0, day, h || 0, min || 0, tz);
}

/** [inicio, fin) de un día de calendario del estudio, como instantes UTC. */
export function rangoDiaEnZona(fechaISO: string, tz: string = ZONA_ESTUDIO): { inicio: Date; fin: Date } {
  return {
    inicio: instanteDeFechaHoraEnZona(fechaISO, '00:00', tz),
    fin: instanteDeFechaHoraEnZona(sumarDiasISO(fechaISO, 1), '00:00', tz)
  };
}

/** 'HH:mm' (24 h) de un instante, en la zona del estudio. */
export function formatHoraEnZona(x: Date | string, tz: string = ZONA_ESTUDIO, hour12 = false): string {
  return new Date(x).toLocaleTimeString('es-MX', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    ...(hour12 ? { hour12: true } : { hourCycle: 'h23' })
  });
}

/** toLocaleDateString en la zona del estudio. */
export function formatFechaEnZona(x: Date | string, opts: Intl.DateTimeFormatOptions, tz: string = ZONA_ESTUDIO): string {
  return new Date(x).toLocaleDateString('es-MX', { timeZone: tz, ...opts });
}

/** toLocaleString (fecha + hora) en la zona del estudio. */
export function formatFechaHoraEnZona(x: Date | string, opts: Intl.DateTimeFormatOptions, tz: string = ZONA_ESTUDIO): string {
  return new Date(x).toLocaleString('es-MX', { timeZone: tz, ...opts });
}
