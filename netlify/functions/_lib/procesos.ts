import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PKG-06G · Evidencia durable de cada corrida de un proceso programado, sin
 * depender de Sentry. Una fila de estado actual por proceso
 * (`procesos_programados`); el atraso lo DERIVA `v_pendientes_operativos` al
 * leerse, así que un cron que ni siquiera corre también se ve.
 *
 * Se asienta al FINAL de la corrida (nunca al empezar): `exito` solo cuando la
 * iteración prevista terminó. Nunca lanza: si no se puede asentar, el atraso lo
 * delatará después. Sin texto de error crudo: solo una clase fija.
 */

export type ProcesoProgramado =
  | 'cron-expirar-membresias'
  | 'cron-no-shows'
  | 'cron-email'
  | 'cron-push'
  | 'cron-recordatorios'
  | 'cron-material-vencido';

export type EstadoEjecucion = 'exito' | 'parcial' | 'fallo' | 'omitido';
export type ClaseError = 'base_datos' | 'proveedor' | 'almacenamiento' | 'configuracion' | 'interno';

export async function registrarEjecucion(
  admin: SupabaseClient | null,
  proceso: ProcesoProgramado,
  estado: EstadoEjecucion,
  clase: ClaseError | null = null
): Promise<void> {
  if (!admin) return; // sin cliente no hay cómo asentar: el atraso lo delatará
  try {
    const { error } = await admin.rpc('registrar_ejecucion_proceso', {
      p_proceso: proceso,
      p_estado: estado,
      p_clase_error: estado === 'exito' ? null : clase
    });
    if (error) console.error('[procesos] no se pudo asentar la ejecución', proceso, estado, error.message);
  } catch (e) {
    console.error('[procesos] no se pudo asentar la ejecución', proceso, estado, e instanceof Error ? e.message : e);
  }
}
