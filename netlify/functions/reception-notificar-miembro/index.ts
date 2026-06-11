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
 * POST /reception-notificar-miembro
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { miembro_id, mensaje }
 *
 * Manda un aviso in-app puntual al miembro (Bloque E). Inserta en
 * `notificaciones` (mismo formato que cancelar_reserva_atomic) con
 * tipo='aviso_manual' y registra en audit_log. El contenido del aviso ES la
 * auditoría → motivo NO obligatorio.
 *
 * Va por service_role (la policy de notificaciones solo deja insertar a admin
 * vía PostgREST; acá validamos rol/tenant en la función).
 */

const MAX_MENSAJE = 500;

interface Body {
  miembro_id?: string;
  mensaje?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.miembro_id) return badRequest('miembro_id requerido');
    const mensaje = typeof body.mensaje === 'string' ? body.mensaje.trim() : '';
    if (!mensaje) return badRequest('El mensaje no puede estar vacío');
    if (mensaje.length > MAX_MENSAJE) return badRequest(`El mensaje es muy largo (máx ${MAX_MENSAJE})`);

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

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id')
      .eq('id', body.miembro_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) {
      return forbidden('El miembro pertenece a otro estudio');
    }

    const { error: insErr } = await supabaseAdmin.from('notificaciones').insert({
      tenant_id: target.tenant_id,
      usuario_id: target.id,
      tipo: 'aviso_manual',
      titulo: 'Aviso del estudio',
      mensaje
    });
    if (insErr) return serverError(insErr.message);

    await writeAuditLog(supabaseAdmin, {
      tenant_id: target.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'notification_sent',
      target_tipo: 'usuario',
      target_id: target.id,
      despues: { mensaje }
    });

    return ok({ success: true });
  } catch (e) {
    console.error('[reception-notificar-miembro]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
