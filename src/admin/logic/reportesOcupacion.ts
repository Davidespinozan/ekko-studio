// ============================================================================
// Cálculo PURO del bloque OCUPACIÓN Y ASISTENCIA del admin. Sin Supabase ni
// React: recibe recursos + reservas de un período y devuelve ocupación por
// estudio, asistencia y el heatmap de demanda (día × hora).
//
// Ocupación = horas reservadas ÷ (horas abiertas × cupos × semanas). Las horas
// abiertas salen de recursos.horarios (bloques semanales {dia, inicio, fin}).
// ============================================================================

export interface HorarioBloque {
  dia: string; // 'lunes' | ... | 'domingo' (sin tildes)
  inicio: string; // 'HH:mm'
  fin: string; // 'HH:mm'
}

export interface RecursoLite {
  id: string;
  nombre: string;
  cupos: number;
  horarios: HorarioBloque[];
}

export interface ReservaLite {
  recurso_id: string;
  status: string;
  duracion_min: number | null;
  slot_inicio: string;
}

export interface OcupacionEstudio {
  id: string;
  nombre: string;
  reservas: number;
  horasReservadas: number;
  ocupacionPct: number | null; // null si el estudio no tiene horarios (capacidad 0)
  asistenciaPct: number | null; // null si no hubo sesiones con desenlace
  noShows: number;
}

export interface OcupacionResult {
  dias: number;
  ocupacionPct: number | null;
  asistenciaPct: number | null;
  totalReservas: number;
  horasReservadas: number;
  noShows: number;
  porEstudio: OcupacionEstudio[];
  heatmap: number[][]; // 7 filas (lun..dom) × 24 horas
  heatmapMax: number;
}

import { partesEnZona } from '@shared/lib/timezone';

// Reservas que OCUPARON el slot (bloquearon la agenda). Canceladas liberan.
const BOOKED = new Set(['confirmada', 'completada', 'no_show']);

function hhmmToMin(s: string): number {
  const [h, m] = (s ?? '').split(':').map((x) => parseInt(x, 10));
  if (Number.isNaN(h)) return 0;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

/** Horas que el estudio está abierto por semana (suma de sus bloques). */
export function horasAbiertasSemana(horarios: HorarioBloque[]): number {
  let min = 0;
  for (const b of horarios ?? []) {
    const dur = hhmmToMin(b.fin) - hhmmToMin(b.inicio);
    if (dur > 0) min += dur;
  }
  return min / 60;
}

/** Índice de fila del heatmap con lunes primero (0=lun … 6=dom). */
function filaLunesPrimero(jsDay: number): number {
  return (jsDay + 6) % 7;
}

export function calcularOcupacion(
  recursos: RecursoLite[],
  reservas: ReservaLite[],
  dias: number
): OcupacionResult {
  const semanas = dias / 7;

  // Acumuladores por estudio.
  const acum = new Map<string, { reservas: number; horas: number; completadas: number; noShows: number }>();
  for (const r of recursos) acum.set(r.id, { reservas: 0, horas: 0, completadas: 0, noShows: 0 });

  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let heatmapMax = 0;

  for (const rv of reservas) {
    if (!BOOKED.has(rv.status)) continue;
    const a = acum.get(rv.recurso_id);
    if (a) {
      a.reservas += 1;
      a.horas += (rv.duracion_min ?? 0) / 60;
      if (rv.status === 'completada') a.completadas += 1;
      if (rv.status === 'no_show') a.noShows += 1;
    }
    // Heatmap de demanda en la HORA DEL ESTUDIO (no la del navegador).
    const d = new Date(rv.slot_inicio);
    if (!Number.isNaN(d.getTime())) {
      const { dow, hour } = partesEnZona(d);
      const fila = filaLunesPrimero(dow);
      const v = (heatmap[fila][hour] += 1);
      if (v > heatmapMax) heatmapMax = v;
    }
  }

  const porEstudio: OcupacionEstudio[] = recursos.map((r) => {
    const a = acum.get(r.id)!;
    const capacidadHoras = horasAbiertasSemana(r.horarios) * Math.max(1, r.cupos) * semanas;
    const desenlaces = a.completadas + a.noShows;
    return {
      id: r.id,
      nombre: r.nombre,
      reservas: a.reservas,
      horasReservadas: Math.round(a.horas * 10) / 10,
      ocupacionPct: capacidadHoras > 0 ? Math.min(100, (a.horas / capacidadHoras) * 100) : null,
      asistenciaPct: desenlaces > 0 ? (a.completadas / desenlaces) * 100 : null,
      noShows: a.noShows
    };
  });
  porEstudio.sort((x, y) => y.reservas - x.reservas);

  // Globales.
  let capacidadTotal = 0;
  let horasTotal = 0;
  let completadasTotal = 0;
  let noShowsTotal = 0;
  let reservasTotal = 0;
  for (const r of recursos) {
    const a = acum.get(r.id)!;
    capacidadTotal += horasAbiertasSemana(r.horarios) * Math.max(1, r.cupos) * semanas;
    horasTotal += a.horas;
    completadasTotal += a.completadas;
    noShowsTotal += a.noShows;
    reservasTotal += a.reservas;
  }
  const desenlacesTotal = completadasTotal + noShowsTotal;

  return {
    dias,
    ocupacionPct: capacidadTotal > 0 ? Math.min(100, (horasTotal / capacidadTotal) * 100) : null,
    asistenciaPct: desenlacesTotal > 0 ? (completadasTotal / desenlacesTotal) * 100 : null,
    totalReservas: reservasTotal,
    horasReservadas: Math.round(horasTotal * 10) / 10,
    noShows: noShowsTotal,
    porEstudio,
    heatmap,
    heatmapMax
  };
}
