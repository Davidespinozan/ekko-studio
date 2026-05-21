import { supabase } from '@shared/lib/supabase';
import { traducirErrorReserva } from './traducirErrorReserva';

/**
 * Orquestación de "reprogramar reserva" para recepción (Sprint RP-3b).
 *
 * D6: reprogramar = cancelar la vieja + crear la nueva. NO es atómico —
 * reusa los dos RPCs de RP-1 (`reservar_para_miembro_atomic` +
 * `cancelar_reserva_atomic`). El punto delicado es el ORDEN y el manejo
 * de fallos parciales: un fallo parcial NUNCA se deja en silencio.
 *
 * Orden (ver PASO 0 de RP-3b):
 *  - Si el nuevo horario NO choca con la reserva vieja → crear primero,
 *    cancelar después. Si crear falla, la vieja queda intacta.
 *  - Si el nuevo horario SÍ choca (contiguo, o solape en el mismo
 *    recurso) → `reservar_para_miembro_atomic` rechazaría la creación
 *    mientras la vieja siga 'confirmada', así que hay que cancelar
 *    primero. Si crear falla tras cancelar, el miembro queda sin
 *    reserva y se avisa con todas las letras.
 */

export interface ReprogramarParams {
  reservaOriginalId: string;
  usuarioId: string;
  original: { recursoId: string; inicio: Date; fin: Date };
  nuevo: { recursoId: string; slotInicio: Date; duracionMin: number; notas: string | null };
}

export type ReprogramarResultado =
  /** Éxito total: nueva creada + vieja cancelada. */
  | { estado: 'ok'; mensaje: string }
  /** Falló crear; nada se tocó, la reserva original sigue en pie. */
  | { estado: 'error_crear'; mensaje: string }
  /** Falló cancelar antes de intentar crear; la original sigue en pie. */
  | { estado: 'error_cancelar'; mensaje: string }
  /** Parcial: la nueva se creó pero la vieja NO se canceló → cancelar manual. */
  | { estado: 'parcial_sin_cancelar'; mensaje: string }
  /** Parcial: la vieja se canceló pero la nueva NO se creó → el miembro quedó sin reserva. */
  | { estado: 'parcial_sin_recrear'; mensaje: string };

function solapan(aIni: number, aFin: number, bIni: number, bFin: number): boolean {
  return aIni < bFin && bIni < aFin;
}

function contiguos(aIni: number, aFin: number, bIni: number, bFin: number): boolean {
  return aFin === bIni || bFin === aIni;
}

/**
 * ¿Crear la nueva reserva ANTES de cancelar la vieja sería rechazado por
 * `reservar_para_miembro_atomic` (porque la vieja sigue 'confirmada')?
 *  - EKKO_CONTINUA: el nuevo slot es exactamente contiguo al viejo
 *    (cualquier recurso).
 *  - EKKO_SLOT_OCUPADO: el nuevo slot solapa al viejo en el MISMO recurso.
 */
export function debeCancelarPrimero(
  original: { recursoId: string; inicio: number; fin: number },
  nuevo: { recursoId: string; inicio: number; fin: number }
): boolean {
  const adyacente = contiguos(original.inicio, original.fin, nuevo.inicio, nuevo.fin);
  const solapaMismoRecurso =
    original.recursoId === nuevo.recursoId &&
    solapan(original.inicio, original.fin, nuevo.inicio, nuevo.fin);
  return adyacente || solapaMismoRecurso;
}

/** Llama `reservar_para_miembro_atomic`. Devuelve el mensaje de error crudo o null. */
async function crearNueva(p: ReprogramarParams): Promise<string | null> {
  // Cast: el RPC de RP-1 aún no está en los tipos generados de Supabase
  // (mismo patrón que CrearReservaModal).
  const { error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ error: { message: string } | null }>)('reservar_para_miembro_atomic', {
    p_usuario_id: p.usuarioId,
    p_recurso_id: p.nuevo.recursoId,
    p_slot_inicio: p.nuevo.slotInicio.toISOString(),
    p_duracion_min: p.nuevo.duracionMin,
    p_invitados: 0,
    p_notas: p.nuevo.notas
  });
  return error ? error.message : null;
}

/** Llama `cancelar_reserva_atomic`. Devuelve el mensaje de error crudo o null. */
async function cancelarVieja(reservaId: string): Promise<string | null> {
  const { error } = await supabase.rpc('cancelar_reserva_atomic', {
    p_reserva_id: reservaId,
    p_motivo: 'Reprogramada por recepción'
  });
  return error ? error.message : null;
}

export async function reprogramarReserva(p: ReprogramarParams): Promise<ReprogramarResultado> {
  const original = {
    recursoId: p.original.recursoId,
    inicio: p.original.inicio.getTime(),
    fin: p.original.fin.getTime()
  };
  const nuevo = {
    recursoId: p.nuevo.recursoId,
    inicio: p.nuevo.slotInicio.getTime(),
    fin: p.nuevo.slotInicio.getTime() + p.nuevo.duracionMin * 60_000
  };

  if (debeCancelarPrimero(original, nuevo)) {
    // El nuevo horario choca con la vieja → hay que cancelar primero.
    const errCancelar = await cancelarVieja(p.reservaOriginalId);
    if (errCancelar) {
      return {
        estado: 'error_cancelar',
        mensaje: `No se pudo reprogramar: ${traducirErrorReserva(errCancelar)} La reserva original sigue en pie.`
      };
    }
    const errCrear = await crearNueva(p);
    if (errCrear) {
      return {
        estado: 'parcial_sin_recrear',
        mensaje:
          `Se canceló la reserva original pero NO se pudo crear la nueva: ${traducirErrorReserva(errCrear)} ` +
          'El miembro quedó SIN reserva — reservá de nuevo.'
      };
    }
    return { estado: 'ok', mensaje: 'Reserva reprogramada.' };
  }

  // Orden preferido: crear la nueva primero. Si falla, la vieja queda intacta.
  const errCrear = await crearNueva(p);
  if (errCrear) {
    return {
      estado: 'error_crear',
      mensaje: `No se pudo reprogramar: ${traducirErrorReserva(errCrear)} La reserva original sigue en pie.`
    };
  }
  const errCancelar = await cancelarVieja(p.reservaOriginalId);
  if (errCancelar) {
    return {
      estado: 'parcial_sin_cancelar',
      mensaje:
        'Se creó la nueva reserva, pero NO se pudo cancelar la anterior. ' +
        'Cancelá la reserva original manualmente desde el perfil.'
    };
  }
  return { estado: 'ok', mensaje: 'Reserva reprogramada.' };
}
