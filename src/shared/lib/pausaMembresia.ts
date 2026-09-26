import { supabase } from './supabase';

/**
 * Pausar la membresía (viaje, lesión) deja la CUENTA en `suspendido` — el mismo
 * status que una sanción del admin. Por eso a quien pidió una pausa se le decía
 * "Tu cuenta está suspendida. Contacta al estudio para reactivarla", que suena a
 * castigo. Aquí se distingue: si la suspensión viene de una membresía `pausada`,
 * el mensaje lo explica y dice cómo volver.
 */
export const MENSAJE_EN_PAUSA =
  'Tu membresía está en pausa: no se te cobra ni puedes reservar mientras dure. Cuando quieras volver, pasa a recepción o escríbele al estudio para reanudarla.';

/** ¿La cuenta suspendida lo está por una PAUSA de su membresía? (lee sus propias filas por RLS). */
export async function suspendidoPorPausa(usuarioId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('membresias')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('status', 'pausada')
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false; // ante la duda, el mensaje genérico
  }
}
