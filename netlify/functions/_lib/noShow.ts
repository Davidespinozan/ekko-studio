/**
 * Penalización por no-show — lógica PURA compartida por el cron (`marcar_no_shows`,
 * en SQL) y por recepción (`reception-marcar-no-show`). Lee la config del tenant
 * en vez de hardcodear "3 faltas / 7 días": Admin → Reglas → Penalizaciones era
 * una perilla muerta (el valor se guardaba y nadie lo leía).
 *
 *   config.penalizaciones.no_show_bloqueo_dias  → días de bloqueo (0 = solo
 *                                                 registrar la falta, sin bloquear)
 *   config.penalizaciones.no_show_umbral        → a partir de qué falta se bloquea
 *
 * El SQL (migración no_show_bloqueo_config) replica exactamente estas reglas.
 */

export interface PenalizacionConfig {
  bloqueo_dias: number; // >= 0
  umbral: number; // >= 1
}

export const PENALIZACION_DEFAULT: PenalizacionConfig = { bloqueo_dias: 7, umbral: 3 };

function enteroNoNegativo(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Lee `config.penalizaciones` tolerando config nulo, strings y valores basura. */
export function leerPenalizacionConfig(config: unknown): PenalizacionConfig {
  const pen = ((config as { penalizaciones?: unknown } | null)?.penalizaciones ?? {}) as Record<string, unknown>;
  const bloqueo_dias = enteroNoNegativo(pen.no_show_bloqueo_dias, PENALIZACION_DEFAULT.bloqueo_dias);
  const umbral = Math.max(1, enteroNoNegativo(pen.no_show_umbral, PENALIZACION_DEFAULT.umbral));
  return { bloqueo_dias, umbral };
}

export interface PenalizacionResultado {
  countNuevo: number;
  bloqueadoHasta: string | null;
  /** true si ESTA falta activó/extendió un bloqueo. */
  bloquea: boolean;
}

/**
 * count+1 siempre; bloquea SOLO si hay días configurados (>0) y se alcanzó el
 * umbral. Si ya había un bloqueo más largo vigente, se respeta (GREATEST).
 */
export function calcularPenalizacionNoShow(args: {
  countAntes: number | null | undefined;
  bloqueadoHasta: string | null | undefined;
  cfg: PenalizacionConfig;
  ahora?: Date;
}): PenalizacionResultado {
  const ahora = args.ahora ?? new Date();
  const countNuevo = (args.countAntes ?? 0) + 1;
  const previo = args.bloqueadoHasta ? new Date(args.bloqueadoHasta) : null;
  const previoVigente = previo && previo.getTime() > ahora.getTime() ? previo : null;

  const alcanzaUmbral = countNuevo >= args.cfg.umbral;
  if (!alcanzaUmbral || args.cfg.bloqueo_dias <= 0) {
    return { countNuevo, bloqueadoHasta: args.bloqueadoHasta ?? null, bloquea: false };
  }

  const base = previoVigente ?? ahora;
  const nuevo = new Date(base.getTime() + args.cfg.bloqueo_dias * 24 * 60 * 60 * 1000);
  return { countNuevo, bloqueadoHasta: nuevo.toISOString(), bloquea: true };
}

/** Texto del aviso al miembro (in-app + push). */
export function mensajeNoShow(args: {
  folio: string | null | undefined;
  resultado: PenalizacionResultado;
  cfg: PenalizacionConfig;
  zona?: string;
}): { titulo: string; mensaje: string } {
  const zona = args.zona ?? 'America/Mazatlan';
  const ref = args.folio ? ` (${args.folio})` : '';
  const faltas = `Llevas ${args.resultado.countNuevo} de ${args.cfg.umbral} faltas permitidas.`;
  if (args.resultado.bloquea && args.resultado.bloqueadoHasta) {
    const hasta = new Date(args.resultado.bloqueadoHasta).toLocaleDateString('es-MX', {
      timeZone: zona,
      day: 'numeric',
      month: 'short'
    });
    return {
      titulo: 'Cuenta bloqueada por inasistencia',
      mensaje: `No llegaste a tu sesión reservada${ref}. ${faltas} Tu cuenta queda bloqueada para reservar hasta el ${hasta}.`
    };
  }
  const restantes = Math.max(0, args.cfg.umbral - args.resultado.countNuevo);
  const aviso =
    args.cfg.bloqueo_dias > 0 && restantes > 0
      ? ` Si faltas ${restantes === 1 ? 'una vez más' : `${restantes} veces más`}, tu cuenta se bloquea ${args.cfg.bloqueo_dias} días.`
      : '';
  return {
    titulo: 'Registramos una inasistencia',
    mensaje: `No llegaste a tu sesión reservada${ref}. ${faltas}${aviso}`
  };
}
