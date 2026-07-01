import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';

/**
 * POST /reception-observar-reserva
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { reserva_id, observaciones }
 *
 * Guarda la observación de sesión del ESTUDIO sobre una reserva (expediente:
 * mal uso de equipo, compra extra, etc.). Va por service_role (recepción no
 * puede tocar reservas por PostgREST) + audit_log. Mismo tenant (H3).
 */

const MAX = 2000;

interface Body {
  reserva_id?: string;
  observaciones?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.reserva_id) return badRequest('reserva_id requerido');
    const observaciones = typeof body.observaciones === 'string' ? body.observaciones.trim() : '';
    if (observaciones.length > MAX) return badRequest(`La observación es muy larga (máx ${MAX})`);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: caller } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!caller || !['admin', 'recepcionista'].includes(caller.rol)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: reserva, error: resErr } = await supabaseAdmin
      .from('reservas')
      .select('id, tenant_id, usuario_id, observaciones')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (resErr) return serverError(resErr.message);
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.tenant_id !== caller.tenant_id) {
      return forbidden('La reserva pertenece a otro estudio');
    }

    const nuevoValor = observaciones || null;
    const { error: upErr } = await supabaseAdmin
      .from('reservas')
      .update({ observaciones: nuevoValor })
      .eq('id', reserva.id);
    if (upErr) return serverError(upErr.message);

    await writeAuditLog(supabaseAdmin, {
      tenant_id: reserva.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'reserva_observacion',
      target_tipo: 'reserva',
      target_id: reserva.id,
      antes: { observaciones: reserva.observaciones ?? null },
      despues: { observaciones: nuevoValor }
    });

    return ok({ success: true, observaciones: nuevoValor });
  } catch (e) {
    console.error('[reception-observar-reserva]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
