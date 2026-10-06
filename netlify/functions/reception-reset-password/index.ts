import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { esStaffActivo } from '../_lib/staff';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /reception-reset-password
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, motivo? }
 *
 * Genera una contraseña temporal nueva para el miembro (cuando olvidó el
 * acceso) y la devuelve para que recepción se la entregue en mostrador.
 *
 * PKG-06A: la mutación de la contraseña vive en el proveedor de Auth y no es
 * transaccional con Postgres; no se finge. Orden: validar → Auth → RPC
 * `cuenta_password_reseteada` (aviso cambiar_password + audit con actor, en UNA
 * transacción). Si la RPC falla después de que Auth aceptó, la respuesta sigue
 * siendo verdad: la contraseña SÍ cambió (se entrega) y se dice que la evidencia
 * no quedó (`evidencia_registrada: false`); un fallo del aviso nunca convierte un
 * reset exitoso en un falso "no se pudo". NUNCA se guarda la contraseña.
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
      .select('id, auth_id, tenant_id, email, rol')
      .eq('id', usuario_id)
      .maybeSingle();
    if (targetErr) return serverError('No se pudo cargar la cuenta. Intenta de nuevo.');
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro es de otro tenant');
    if (!target.auth_id) return badRequest('Esta cuenta no tiene acceso creado todavía');

    // Escalada: recepción solo resetea a MIEMBROS. Las claves del staff
    // (admin/recepcionista) solo las resetea un admin. Sin este guard un
    // recepcionista podía tomar la cuenta de un admin vía API.
    if (target.rol !== 'miembro' && caller.rol !== 'admin') {
      return forbidden('Solo un admin puede resetear la contraseña del equipo');
    }

    const nuevaPassword = generarPassword();

    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(target.auth_id, {
      password: nuevaPassword
    });
    if (pwErr) {
      await reportarErrorServidor('reception-reset-password', new Error(pwErr.message), { paso: 'auth.updateUserById', usuario_id });
      return serverError('No se pudo restablecer la contraseña. Intenta de nuevo.');
    }

    // Evidencia + aviso "cambia tu contraseña temporal" (gate de 02C), en una
    // transacción y con el actor. La contraseña NO viaja a la base.
    const { error: rpcErr } = await supabaseAdmin.rpc('cuenta_password_reseteada', {
      p_actor_id: caller.id,
      p_usuario_id: target.id,
      p_motivo: typeof motivo === 'string' && motivo.trim() ? motivo.trim() : null
    });
    if (rpcErr) {
      // La contraseña YA cambió: se entrega y se dice que la evidencia no quedó.
      await reportarErrorServidor('reception-reset-password', new Error(rpcErr.message), { paso: 'cuenta_password_reseteada', usuario_id });
      return ok({
        success: true,
        email: target.email,
        password: nuevaPassword,
        evidencia_registrada: false,
        aviso: 'La contraseña se restableció, pero no quedó registrada en el historial ni se dejó el aviso de cambiarla. Repórtalo al admin.'
      });
    }

    // El password se devuelve para entregar en mostrador — NUNCA loguearlo.
    return ok({ success: true, email: target.email, password: nuevaPassword, evidencia_registrada: true });
  } catch (e) {
    console.error('[reception-reset-password]', e);
    return serverError('No se pudo restablecer la contraseña. Intenta de nuevo.');
  }
};
