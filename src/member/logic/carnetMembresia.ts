// ============================================================================
// carnetMembresia — lógica pura para el "carnet" del Dashboard del miembro.
//
// Traduce el estado crudo de la membresía (tipo de plan + status + créditos +
// fin de periodo) en el texto que se pinta en el carnet dorado. Separado de la
// UI para poder testearlo sin montar componentes.
//
// Tipos de plan (tiers.tipo):
//   - 'tiempo'   → acceso por periodo (renueva / vence en una fecha)
//   - 'creditos' → paquete de N créditos que se consumen por reserva
//   - 'hibrido'  → ambos (periodo + bolsa de créditos)
// ============================================================================

export type TipoPlan = 'tiempo' | 'creditos' | 'hibrido';

export interface EntradaCarnet {
  tipo: TipoPlan | string | null;
  status: string | null | undefined;
  creditosRestantes: number | null;
  periodoActualFin: string | null;
  /** ISO "ahora" inyectable para tests; default = new Date(). */
  ahora?: Date;
}

export type TonoEstado = 'success' | 'warning' | 'danger' | 'neutral';

export interface ResumenCarnet {
  /** Línea principal debajo del nombre del plan. */
  titulo: string;
  /** Línea secundaria (renovación / créditos). Puede ser null. */
  subtitulo: string | null;
  /** Etiqueta corta del badge de estado. */
  estadoLabel: string;
  estadoTono: TonoEstado;
  /** true si el miembro no puede reservar y hay que empujarlo a resolver. */
  requiereAccion: boolean;
}

function esActiva(status: string | null | undefined): boolean {
  return status === 'activa' || status === 'active';
}

function formatearFechaCorta(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
}

function textoCreditos(n: number): string {
  return n === 1 ? '1 crédito disponible' : `${n} créditos disponibles`;
}

/**
 * Devuelve el texto del carnet para una membresía dada. Nunca lanza; si faltan
 * datos degrada a un mensaje razonable.
 */
export function resumenCarnet(entrada: EntradaCarnet): ResumenCarnet {
  const { tipo, status, creditosRestantes, periodoActualFin } = entrada;
  const ahora = entrada.ahora ?? new Date();
  const creditos = creditosRestantes ?? 0;

  // --- Estados que bloquean, en orden de prioridad -------------------------
  if (status === 'pendiente_pago') {
    return {
      titulo: 'Tu plan está pendiente de pago',
      subtitulo: 'Completá el pago para activar tu acceso.',
      estadoLabel: 'Pendiente',
      estadoTono: 'warning',
      requiereAccion: true
    };
  }
  if (status === 'suspendida') {
    return {
      titulo: 'Membresía suspendida',
      subtitulo: 'Contactá a EKKO para reactivarla.',
      estadoLabel: 'Suspendida',
      estadoTono: 'danger',
      requiereAccion: true
    };
  }
  if (status === 'cancelada' || !status) {
    return {
      titulo: 'Sin membresía activa',
      subtitulo: 'Elegí un plan para empezar a reservar.',
      estadoLabel: 'Sin plan',
      estadoTono: 'neutral',
      requiereAccion: true
    };
  }

  // --- Vencida por fecha (planes con periodo) ------------------------------
  const finDate = periodoActualFin ? new Date(periodoActualFin) : null;
  const venció = finDate && !Number.isNaN(finDate.getTime()) && finDate < ahora;
  if (esActiva(status) && venció && (tipo === 'tiempo' || tipo === 'hibrido')) {
    return {
      titulo: 'Tu periodo venció',
      subtitulo: 'Renová para seguir reservando.',
      estadoLabel: 'Vencida',
      estadoTono: 'warning',
      requiereAccion: true
    };
  }

  // --- Sin créditos (planes por créditos) ----------------------------------
  if (esActiva(status) && tipo === 'creditos' && creditos <= 0) {
    return {
      titulo: 'Te quedaste sin créditos',
      subtitulo: 'Comprá más para seguir reservando.',
      estadoLabel: 'Sin créditos',
      estadoTono: 'warning',
      requiereAccion: true
    };
  }

  // --- Activa y sana: texto según el tipo de plan --------------------------
  const renovacion = finDate && !venció ? `Renueva el ${formatearFechaCorta(periodoActualFin!)}` : null;

  if (tipo === 'creditos') {
    return {
      titulo: textoCreditos(creditos),
      subtitulo: creditos <= 2 ? 'Te quedan pocos, considerá recargar.' : null,
      estadoLabel: 'Activa',
      estadoTono: 'success',
      requiereAccion: false
    };
  }

  if (tipo === 'hibrido') {
    return {
      titulo: textoCreditos(creditos),
      subtitulo: renovacion,
      estadoLabel: 'Activa',
      estadoTono: 'success',
      requiereAccion: false
    };
  }

  // tipo === 'tiempo' (o desconocido) → acceso por periodo
  return {
    titulo: 'Acceso activo',
    subtitulo: renovacion,
    estadoLabel: 'Activa',
    estadoTono: 'success',
    requiereAccion: false
  };
}
