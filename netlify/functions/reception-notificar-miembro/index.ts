import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { enviarPushAUsuario, clasificarPush, registrarResultadoPush } from '../_lib/push';
import { esStaffActivo } from '../_lib/staff';

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
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(caller)) {
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

    const { data: creada, error: insErr } = await supabaseAdmin.from('notificaciones').insert({
      tenant_id: target.tenant_id,
      usuario_id: target.id,
      tipo: 'aviso_manual',
      titulo: 'Aviso del estudio',
      mensaje,
      // PKG-03A: el push sale aquí mismo; el lease evita que cron-push lo repita.
      push_intento_at: new Date().toISOString()
    }).select('id').maybeSingle();
    if (insErr) return serverError(insErr.message);

    // Entrega push (además del aviso in-app) y resultado asentado DESPUÉS de
    // intentar. No-op si no hay VAPID configurado (queda `sin_config`).
    const r = await enviarPushAUsuario(supabaseAdmin, target.id, {
      titulo: 'Aviso del estudio',
      mensaje,
      url: '/app',
      tag: 'aviso_manual'
    });
    const push = clasificarPush(r);
    if (creada?.id) await registrarResultadoPush(supabaseAdmin, [creada.id], push);

    // PKG-03A (F-9): se registra un aviso; "enviado" afirmaba más de lo que se sabe.
    await writeAuditLog(supabaseAdmin, {
      tenant_id: target.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'aviso_registrado',
      target_tipo: 'usuario',
      target_id: target.id,
      despues: { mensaje, push }
    });

    return ok({ success: true, push });
  } catch (e) {
    console.error('[reception-notificar-miembro]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
