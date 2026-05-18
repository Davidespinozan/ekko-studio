import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /admin-delete-user
 * Auth: Bearer JWT del admin
 * Body: { usuario_id }
 *
 * HARD DELETE: borra de auth.users → cascadea a public.usuarios via
 * FK (auth_id ON DELETE CASCADE). Cascadea también a notificaciones,
 * membresias (CASCADE). Pagos quedan huérfanos (SET NULL).
 *
 * Bloquea si target tiene reservas (FK reservas.usuario_id RESTRICT) —
 * el admin debe cancelarlas/limpiarlas primero. Esto preserva
 * integridad de auditoría de reservas (folio, slot, status).
 *
 * Guards:
 *  - Caller debe ser admin del tenant.
 *  - Target debe ser del mismo tenant.
 *  - No puede borrarse a sí mismo.
 *  - No puede borrar al último admin activo del tenant.
 */

interface DeleteUserRequest {
  usuario_id: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: DeleteUserRequest = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: adminProfile } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!adminProfile || adminProfile.rol !== 'admin') {
      return forbidden('Solo admin puede eliminar usuarios');
    }

    if (adminProfile.id === body.usuario_id) {
      return badRequest('No puedes eliminarte a ti mismo');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // Obtener target
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id, rol, auth_id, email, nombre')
      .eq('id', body.usuario_id)
      .maybeSingle();

    if (targetErr || !target) return badRequest('Usuario no encontrado');

    if (target.tenant_id !== adminProfile.tenant_id) {
      return forbidden('Usuario es de otro tenant');
    }

    // No borrar último admin
    if (target.rol === 'admin') {
      const { count: adminCount } = await supabaseAdmin
        .from('usuarios')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', target.tenant_id)
        .eq('rol', 'admin')
        .neq('status', 'revocado');

      if ((adminCount ?? 0) <= 1) {
        return badRequest('No puedes eliminar al último admin del tenant');
      }
    }

    // Pre-check: reservas (FK RESTRICT bloquearía el delete)
    const { count: reservasCount } = await supabaseAdmin
      .from('reservas')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', target.id);

    if ((reservasCount ?? 0) > 0) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `No se puede eliminar: tiene ${reservasCount} ${reservasCount === 1 ? 'reserva' : 'reservas'} en historial. Cancela o reasigna las reservas antes de eliminar.`,
          reservas_count: reservasCount
        })
      };
    }

    if (!target.auth_id) {
      // Sin auth_id: borrar directo de public.usuarios
      const { error: delErr } = await supabaseAdmin
        .from('usuarios')
        .delete()
        .eq('id', target.id);
      if (delErr) return serverError(delErr.message);
      return ok({ success: true, deleted: { id: target.id, email: target.email } });
    }

    // Borrar de auth.users → CASCADE a usuarios + notificaciones + membresias
    const { error: authDelErr } = await supabaseAdmin.auth.admin.deleteUser(target.auth_id);
    if (authDelErr) return serverError(`Error eliminando cuenta: ${authDelErr.message}`);

    return ok({
      success: true,
      deleted: {
        id: target.id,
        email: target.email,
        nombre: target.nombre
      }
    });
  } catch (e) {
    console.error('[admin-delete-user]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
