import { supabase } from '@shared/lib/supabase';
import { traducirErrorReserva } from './traducirErrorReserva';

/**
 * "Reprogramar reserva" para recepción.
 *
 * R2-A (PKG-01J): UNA llamada a la RPC `reprogramar_reserva`, que en una sola
 * transacción cancela la vieja, crea la nueva con las mismas reglas que una
 * reserva de recepción, traslada los invitados extra pagados (con rastro) y las
 * fichas de invitados, deja UN aviso de cambio de horario y audita. Si algo
 * falla, NADA cambia: la reserva original sigue en pie.
 *
 * Antes (RP-3b) se orquestaba desde el navegador (crear + cancelar + aviso):
 * podía quedar a medias ("parcial_sin_recrear": el miembro sin reserva), perdía
 * observaciones e invitados extra pagados, y el aviso era heurístico.
 */

export interface ReprogramarParams {
  reservaOriginalId: string;
  nuevo: { recursoId: string; slotInicio: Date; duracionMin: number; notas: string | null; invitados?: number };
}

export type ReprogramarResultado =
  /** Reprogramada: la nueva existe y la vieja quedó cancelada, en la misma transacción. */
  | { estado: 'ok'; mensaje: string; reservaId: string | null }
  /** Rechazada: no cambió nada, la reserva original sigue en pie. */
  | { estado: 'error'; mensaje: string };

export async function reprogramarReserva(p: ReprogramarParams): Promise<ReprogramarResultado> {
  // Cast: la RPC nueva aún no está en los tipos generados de Supabase.
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: { reserva_id?: string } | null; error: { message: string } | null }>)('reprogramar_reserva', {
    p_reserva_id: p.reservaOriginalId,
    p_recurso_id: p.nuevo.recursoId,
    p_slot_inicio: p.nuevo.slotInicio.toISOString(),
    p_duracion_min: p.nuevo.duracionMin,
    p_invitados: p.nuevo.invitados ?? null,
    p_notas: p.nuevo.notas
  });
  if (error) {
    return {
      estado: 'error',
      mensaje: `No se pudo reprogramar: ${traducirErrorReserva(error.message)} La reserva original sigue en pie.`
    };
  }
  return { estado: 'ok', mensaje: 'Reserva reprogramada.', reservaId: data?.reserva_id ?? null };
}
