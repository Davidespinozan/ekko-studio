import type { HandlerResponse } from '@netlify/functions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ok, badRequest, forbidden, notFound } from './http';
import { errorInterno } from './errores';

/**
 * R2-A (PKG-01I) · Corrección de asistencia = UNA transición de servidor.
 *
 * `reception-marcar-asistio` y `reception-corregir-checkin` ya no escriben
 * `reservas` / `usuarios` desde Netlify: delegan en la RPC
 * `staff_corregir_asistencia` (service_role), que bloquea la reserva y al
 * miembro, valida la transición, revierte la penalización y audita en la MISMA
 * transacción. Aquí solo se autentica al actor y se traducen los errores.
 */

export type AccionAsistencia = 'asistio' | 'deshacer_checkin';

const conflicto = (code: string, error: string): HandlerResponse => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error, code })
});

/** Traduce el error EKKO_* de la RPC a la respuesta HTTP de la función. */
export function respuestaErrorAsistencia(mensaje: string): HandlerResponse {
  const m = mensaje ?? '';
  const texto = m.replace(/^EKKO_[A-Z_]+:\s*/, '');
  if (m.includes('EKKO_RESERVA_NO_EXISTE')) return notFound('Reserva no encontrada');
  if (m.includes('EKKO_OTRO_ESTUDIO')) return forbidden('La reserva pertenece a otro estudio');
  if (m.includes('EKKO_NO_AUTORIZADO')) return forbidden('Solo recepción o admin pueden hacer esto');
  if (m.includes('EKKO_CUENTA_REVOCADA')) return forbidden(texto);
  if (m.includes('EKKO_TRANSICION_INVALIDA')) return conflicto('transicion_invalida', texto);
  if (m.includes('EKKO_YA_COMPLETADA')) return badRequest('Esta reserva ya tiene check-in');
  if (m.includes('EKKO_SESION_NO_INICIA')) return badRequest('Esa sesión todavía no empieza; no se puede marcar asistencia');
  if (m.includes('EKKO_FUERA_DE_PLAZO')) return badRequest('Solo se puede corregir un check-in del mismo día. Escala a admin.');
  if (m.includes('EKKO_MOTIVO_REQUERIDO')) return badRequest('Motivo obligatorio para esta acción');
  // Guarda de identidad (trigger exigir_identidad_al_ingresar) y demás EKKO_*.
  if (m.includes('EKKO_')) return badRequest(texto);
  return errorInterno('corregir-asistencia', new Error(m || 'error_desconocido'));
}

export async function corregirAsistencia(
  supabaseAdmin: SupabaseClient,
  args: { actorId: string; reservaId: string; accion: AccionAsistencia; motivo: string }
): Promise<HandlerResponse> {
  const { data, error } = await supabaseAdmin.rpc('staff_corregir_asistencia', {
    p_actor_id: args.actorId,
    p_reserva_id: args.reservaId,
    p_accion: args.accion,
    p_motivo: args.motivo
  });
  if (error) return respuestaErrorAsistencia(error.message);
  return ok(data ?? { success: true });
}
