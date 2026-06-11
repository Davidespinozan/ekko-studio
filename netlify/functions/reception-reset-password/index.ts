import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';

/**
 * POST /reception-reset-password
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, motivo? }
 *
 * Genera una contraseña temporal nueva para el miembro (cuando olvidó el
 * acceso) y la devuelve para que recepción se la entregue en mostrador.
 * Va por service_role; valida rol del caller y que el target sea del mismo
 * tenant. Registra el reset en audit_log (insert-only) — NUNCA la contraseña
 * (ni antes/después). Antes vivía en notas_admin (borrable — B1/B2).
 */

// Alfabeto sin caracteres ambiguos (0/O, 1/I/l).
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generarPassword(len = 10): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALFABETO[randomInt(ALFABETO.length)];
  return out;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const { usuario_id, motivo } = JSON.parse(event.body || '{}') as {
      usuario_id?: string;
      motivo?: string;
    };
    if (!usuario_id) return badRequest('usuario_id requerido');

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
      .select('id, auth_id, tenant_id, email')
      .eq('id', usuario_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro es de otro tenant');

    const nuevaPassword = generarPassword();

    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(target.auth_id, {
      password: nuevaPassword
    });
    if (pwErr) return serverError(`No se pudo resetear la contraseña: ${pwErr.message}`);

    // Auditoría inmutable (audit_log) — NUNCA la contraseña ni antes/después.
    await writeAuditLog(supabaseAdmin, {
      tenant_id: target.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'password_reset',
      target_tipo: 'usuario',
      target_id: target.id,
      motivo: typeof motivo === 'string' && motivo.trim() ? motivo.trim() : null
    });

    // El password se devuelve para entregar en mostrador — NUNCA loguearlo.
    return ok({ success: true, email: target.email, password: nuevaPassword });
  } catch (e) {
    console.error('[reception-reset-password]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
