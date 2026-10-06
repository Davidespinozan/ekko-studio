import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { ok, badRequest, unauthorized, forbidden } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv } from '../_lib/env';
import { leerOperationId } from '../_lib/operacionPago';
import { ejecutarOperacionesSuscripcion } from '../_lib/operacionesSuscripcion';
import { codigoRpc } from '../_lib/cuentas';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /stripe-cancelar-suscripcion
 * Auth: Bearer JWT del miembro. Body: { reactivar?: boolean, operation_id?: uuid }.
 *
 * Baja AL FINAL DEL PERIODO (cancel_at_period_end) o su reversión, pedida por el
 * propio miembro. La suscripción se deriva del JWT, nunca del body.
 *
 * PKG-06B (FR-16): primero la intención durable y local, en UNA transacción
 * (`miembro_programar_renovacion`: cancel_at_period_end en EKKO + operación con
 * identidad = operation_id); después Stripe, por el ejecutor común (mismas reglas
 * que las operaciones del staff: revalida, llave de idempotencia por operación e
 * intento, `aplicada`/`fallida` asentado). Si Stripe falla o no responde, la
 * intención del miembro YA quedó, la operación se ve en Operación y se reintenta;
 * la respuesta lo dice (`stripe_pendiente`). El derecho no se toca: la baja surte
 * efecto al fin del periodo. La reactivación no pasa por encima de revocación,
 * sanción ni de una baja que programó el estudio.
 */

interface Body {
  reactivar?: boolean;
  operation_id?: unknown;
}

const MENSAJES: Record<string, string> = {
  CUENTA_REVOCADA: 'Tu acceso fue revocado por el estudio.',
  CUENTA_RESTRINGIDA: 'Tu cuenta está suspendida por el estudio. Escríbenos para resolverlo.',
  BAJA_DEL_ESTUDIO: 'La baja la programó el estudio. Acércate a recepción si quieres revertirla.',
  NO_AUTORIZADO: 'Solo el miembro gestiona su propia renovación.',
  SIN_SUSCRIPCION: 'No tienes una suscripción activa para gestionar.',
  OPERACION_CONFLICTO: 'Esta operación ya corresponde a otra acción. Vuelve a intentarlo.'
};
const COMO_400 = new Set(['SIN_SUSCRIPCION', 'OPERACION_CONFLICTO']);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const reactivar = body.reactivar === true;
    // Identidad de la acción: la manda la app (mismo UUID en cada reintento). Una
    // app vieja sin ella recibe una identidad nueva por petición (el efecto en
    // Stripe es idempotente por estado: cancel_at_period_end true/false).
    const op = leerOperationId(body.operation_id);
    const operationId = op.tipo === 'ok' ? op.id : randomUUID();

    if (!process.env.STRIPE_SECRET_KEY) return badRequest('Pagos no configurados');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    // 1. Intención durable, con la sesión del miembro (el actor lo fija el servidor).
    const { data, error } = await asUser.rpc('miembro_programar_renovacion', {
      p_cancelar: !reactivar,
      p_operation_id: operationId
    });
    if (error) {
      const { codigo } = codigoRpc(error.message);
      if (codigo && MENSAJES[codigo]) {
        return COMO_400.has(codigo) ? badRequest(MENSAJES[codigo]) : forbidden(MENSAJES[codigo]);
      }
      return errorInterno('stripe-cancelar-suscripcion', error, 'No pudimos actualizar tu suscripción. Intenta de nuevo.');
    }
    const r = (data ?? {}) as { operacion_id?: string; usuario_id?: string; cancel_at_period_end?: boolean };

    // 2. Stripe, por el ejecutor común (solo las operaciones de ESTE miembro). Un
    //    fallo aquí no deshace la intención: queda `fallida`, visible y reintentable.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    if (r.usuario_id) {
      try {
        await ejecutarOperacionesSuscripcion(admin, { usuarioId: r.usuario_id });
      } catch (e) {
        await reportarErrorServidor('stripe-cancelar-suscripcion', e, { paso: 'operaciones_suscripcion', operacion_id: r.operacion_id });
      }
    }
    let estadoStripe: string | null = null;
    if (r.operacion_id) {
      const { data: fila } = await admin
        .from('stripe_operaciones_suscripcion')
        .select('estado')
        .eq('id', r.operacion_id)
        .maybeSingle();
      estadoStripe = (fila as { estado?: string } | null)?.estado ?? null;
    }

    return ok({
      success: true,
      cancel_at_period_end: r.cancel_at_period_end ?? !reactivar,
      operacion_id: r.operacion_id ?? null,
      // true = EKKO ya lo tiene, pero Stripe aún no lo confirmó (se reintentará).
      stripe_pendiente: estadoStripe !== 'aplicada'
    });
  } catch (err) {
    return errorInterno('stripe-cancelar-suscripcion', err, 'No pudimos actualizar tu suscripción. Intenta de nuevo.');
  }
};
