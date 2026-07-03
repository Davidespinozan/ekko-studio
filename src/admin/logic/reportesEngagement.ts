// ============================================================================
// Cálculo PURO del bloque ENGAGEMENT Y RETENCIÓN del admin. Mide si los
// miembros que pagan de verdad USAN el estudio, qué tan rápido arrancan, y
// quiénes están por irse. Sin Supabase ni React.
// ============================================================================

const MS_DIA = 24 * 60 * 60 * 1000;
const VENTANA_MAU_DIAS = 30;
const RIESGO_DIAS = 21; // sin venir en 3 semanas = en riesgo

export interface MiembroLite {
  id: string;
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  created_at: string;
}

export interface ReservaEngLite {
  usuario_id: string;
  slot_inicio: string;
  status: string;
  created_at: string;
}

export interface MiembroEnRiesgo {
  id: string;
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  ultimaActividad: string | null; // ISO de la última sesión asistida (null = nunca)
  diasSinVenir: number | null; // null = nunca vino
}

export interface EngagementResult {
  activos: number;
  mau: number; // miembros activos con al menos 1 sesión en 30d
  porcentajeVienen: number | null; // mau / activos
  activacionPct: number | null; // nuevos (90d) que hicieron su 1ª reserva
  cohorteNuevos: number;
  ttvDias: number | null; // días promedio del alta a la 1ª reserva
  enRiesgo: MiembroEnRiesgo[]; // activos sin venir en 21d, más urgentes primero
}

// Sesiones que cuentan como "vino / usó el estudio".
const ASISTIO = new Set(['confirmada', 'completada']);

/**
 * @param miembrosActivos miembros con status activo (rol miembro)
 * @param reservas        reservas recientes (ventana ~90d) con status y fechas
 * @param nuevos90d       miembros dados de alta en los últimos 90 días
 * @param ahoraMs         Date.now() del llamador (inyectado para testear)
 */
export function calcularEngagement(
  miembrosActivos: MiembroLite[],
  reservas: ReservaEngLite[],
  nuevos90d: MiembroLite[],
  ahoraMs: number
): EngagementResult {
  const activosIds = new Set(miembrosActivos.map((m) => m.id));
  const nuevosIds = new Set(nuevos90d.map((m) => m.id));
  const cutoffMau = ahoraMs - VENTANA_MAU_DIAS * MS_DIA;
  const cutoffRiesgo = ahoraMs - RIESGO_DIAS * MS_DIA;

  // Última sesión asistida (slot pasado) por miembro, y set de MAU.
  const ultimaSesion = new Map<string, number>();
  const mauSet = new Set<string>();
  // Primera reserva (por created_at) por miembro, para activación y TTV.
  const primeraReserva = new Map<string, number>();

  for (const rv of reservas) {
    if (!ASISTIO.has(rv.status)) continue;
    const slotMs = new Date(rv.slot_inicio).getTime();
    const bookMs = new Date(rv.created_at).getTime();

    if (!Number.isNaN(bookMs)) {
      const prev = primeraReserva.get(rv.usuario_id);
      if (prev == null || bookMs < prev) primeraReserva.set(rv.usuario_id, bookMs);
    }
    if (Number.isNaN(slotMs)) continue;

    // Sesión pasada = actividad real de asistencia.
    if (slotMs <= ahoraMs) {
      const prev = ultimaSesion.get(rv.usuario_id);
      if (prev == null || slotMs > prev) ultimaSesion.set(rv.usuario_id, slotMs);
      if (slotMs >= cutoffMau && activosIds.has(rv.usuario_id)) mauSet.add(rv.usuario_id);
    }
  }

  const activos = miembrosActivos.length;
  const mau = mauSet.size;
  const porcentajeVienen = activos > 0 ? (mau / activos) * 100 : null;

  // Activación + TTV sobre la cohorte de nuevos (90d).
  let reservaronCohorte = 0;
  let ttvSuma = 0;
  let ttvN = 0;
  for (const m of nuevos90d) {
    const first = primeraReserva.get(m.id);
    if (first == null) continue;
    reservaronCohorte += 1;
    const altaMs = new Date(m.created_at).getTime();
    if (!Number.isNaN(altaMs) && first >= altaMs) {
      ttvSuma += (first - altaMs) / MS_DIA;
      ttvN += 1;
    }
  }
  const activacionPct = nuevosIds.size > 0 ? (reservaronCohorte / nuevosIds.size) * 100 : null;
  const ttvDias = ttvN > 0 ? ttvSuma / ttvN : null;

  // Miembros en riesgo: activos cuya última sesión fue hace >21d (o nunca).
  const enRiesgo: MiembroEnRiesgo[] = [];
  for (const m of miembrosActivos) {
    const ultima = ultimaSesion.get(m.id) ?? null;
    if (ultima != null && ultima >= cutoffRiesgo) continue; // vino hace poco → sano
    enRiesgo.push({
      id: m.id,
      nombre: m.nombre,
      email: m.email,
      telefono: m.telefono,
      ultimaActividad: ultima != null ? new Date(ultima).toISOString() : null,
      diasSinVenir: ultima != null ? Math.floor((ahoraMs - ultima) / MS_DIA) : null
    });
  }
  // Más urgentes primero: los que nunca vinieron (null), luego más días sin venir.
  enRiesgo.sort((a, b) => {
    if (a.diasSinVenir == null && b.diasSinVenir == null) return 0;
    if (a.diasSinVenir == null) return -1;
    if (b.diasSinVenir == null) return 1;
    return b.diasSinVenir - a.diasSinVenir;
  });

  return {
    activos,
    mau,
    porcentajeVienen,
    activacionPct,
    cohorteNuevos: nuevosIds.size,
    ttvDias,
    enRiesgo
  };
}
