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
import { esAdminActivo } from '../_lib/staff';
import { respuestaErrorRpc } from '../_lib/cuentas';

/**
 * POST /admin-update-role
 * Auth: Bearer JWT del admin
 * Body: { usuario_id, rol }
 *
 * PKG-06A: el cambio de rol es UNA transacción del servidor
 * (`cuenta_cambiar_rol`): valida al actor (admin activo), el tenant, que no sea
 * su propio rol, aplica el cambio y deja `rol_cambiado` con el actor explícito.
 * El invariante del último admin lo impone el trigger de `usuarios` (único
 * conteo); su EKKO_ULTIMO_ADMIN llega aquí como 409. Un cambio al mismo rol es
 * idempotente (sin evidencia duplicada).
 */

interface UpdateRoleRequest {
  usuario_id: string;
  rol: 'miembro' | 'recepcionista' | 'admin';
}

const ROLES_VALIDOS = ['miembro', 'recepcionista', 'admin'] as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: UpdateRoleRequest = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');
    if (!ROLES_VALIDOS.includes(body.rol)) return badRequest(`Rol inválido: ${body.rol}`);

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
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!esAdminActivo(adminProfile)) {
      return forbidden('Solo admin puede cambiar roles');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabaseAdmin.rpc('cuenta_cambiar_rol', {
      p_actor_id: adminProfile.id,
      p_usuario_id: body.usuario_id,
      p_rol: body.rol
    });
    if (error) return respuestaErrorRpc('admin-update-role', error, { usuario_id: body.usuario_id });

    const r = (data ?? {}) as { idempotente?: boolean; rol?: string; status?: string };
    return ok({ success: true, usuario_id: body.usuario_id, rol: r.rol ?? body.rol, status: r.status ?? null, idempotente: r.idempotente === true });
  } catch (e) {
    console.error('[admin-update-role]', e);
    return serverError('No se pudo cambiar el rol. Intenta de nuevo.');
  }
};
