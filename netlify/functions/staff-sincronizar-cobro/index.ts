import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, notFound, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { esStaffActivo } from '../_lib/staff';
import { ejecutarOperacionesSuscripcion } from '../_lib/operacionesSuscripcion';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /staff-sincronizar-cobro
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id }
 *
 * R2-B (PKG-01P): ejecuta AHORA las operaciones de cobro pendientes de un
 * miembro (suspender, reanudar o cancelar su suscripción de Stripe). La
 * operación ya existe en `stripe_operaciones_suscripcion`: la creó la base al
 * sancionar, levantar la sanción, revocar o dar de baja. Este endpoint no decide
 * nada: sirve para que una revocación hecha desde el panel (UPDATE directo de
 * `status`) cancele la suscripción de inmediato, sin esperar al cron diario, y
 * para reintentar una operación fallida.
 *
 * No recibe ni acepta qué operación hacer; solo de quién. Sin reembolsos.
 */

interface Body {
  usuario_id?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: staff } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(staff)) return forbidden('Solo recepción o admin pueden hacer esto');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: target } = await admin
      .from('usuarios')
      .select('id, tenant_id')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (!target) return notFound('Cuenta no encontrada');
    if (target.tenant_id !== staff.tenant_id) return forbidden('La cuenta pertenece a otro estudio');

    const cobro = await ejecutarOperacionesSuscripcion(admin, { usuarioId: target.id });
    return ok({ success: true, cobro_stripe: cobro });
  } catch (e) {
    await reportarErrorServidor('staff-sincronizar-cobro', e);
    return serverError('No se pudo sincronizar el cobro con Stripe');
  }
};
