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
import { altaDeCuenta, esAltaOk } from '../_lib/cuentas';

/**
 * POST /admin-create-user
 * Auth: Bearer JWT del admin
 * Body: { email, password, nombre, telefono?, rol, membresia_tier?, perfil_id? }
 *
 * Crea cuenta en Supabase Auth + perfil en `usuarios` del MISMO tenant del admin.
 * Roles permitidos: 'miembro' | 'recepcionista' | 'admin'.
 *
 * PKG-06A: la parte local va por RPC con el admin como actor explícito
 * (`cuenta_alta_preparar` → Auth → `cuenta_alta_finalizar`, ver `_lib/cuentas.ts`).
 * Un perfil existente nunca se adueña por el correo: si tiene historial y no se
 * confirmó sobre ESE perfil (`perfil_id`), el alta se rechaza antes de tocar Auth.
 * Si Auth quedó creada y la finalización falla, solo se revierte lo que esta alta
 * creó; un perfil preexistente nunca se borra como rollback.
 */

interface CreateRequest {
  email: string;
  password: string;
  nombre: string;
  telefono?: string;
  rol: 'miembro' | 'recepcionista' | 'admin';
  membresia_tier?: string | null;
  /** Alta explícita sobre un perfil existente sin acceso (autoriza vincularlo aunque tenga historial). */
  perfil_id?: string | null;
}

const ROLES_VALIDOS = ['miembro', 'recepcionista', 'admin'] as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: CreateRequest = JSON.parse(event.body || '{}');

    // Validación de input
    if (!body.email?.includes('@')) return badRequest('Email inválido');
    if (!body.password || body.password.length < 8) return badRequest('Password debe tener al menos 8 caracteres');
    if (!body.nombre?.trim()) return badRequest('Nombre requerido');
    if (!ROLES_VALIDOS.includes(body.rol)) return badRequest(`Rol inválido: ${body.rol}`);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // Cliente con token del admin (para validar quién es)
    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    // Verificar que es admin del tenant
    const { data: adminProfile } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!esAdminActivo(adminProfile)) {
      return forbidden('Solo admin puede crear usuarios');
    }

    // Cliente con service_role (bypasea RLS para crear cuentas)
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const email = body.email.trim().toLowerCase();
    const nombre = body.nombre.trim();
    const r = await altaDeCuenta({
      funcion: 'admin-create-user',
      admin: supabaseAdmin,
      actorId: adminProfile.id,
      email,
      password: body.password,
      nombre,
      telefono: body.telefono?.trim() || null,
      rol: body.rol,
      tier: body.rol === 'miembro' ? (body.membresia_tier ?? null) : null,
      perfilId: body.perfil_id ?? null
    });
    if (!esAltaOk(r)) return r;

    return ok({
      success: true,
      modo: r.modo,
      recuperada: r.recuperada,
      user: {
        id: r.usuario_id,
        email,
        nombre,
        rol: r.rol,
        status: r.status,
        // SEC-FIX (H4): el password se devuelve para que admin se lo dé al
        // cliente, pero NO debe llegar a ningún log — no hacer console.log
        // de este objeto ni de la respuesta.
        password: body.password
      }
    });
  } catch (e) {
    // Loguear SOLO el Error — nunca el body ni el password.
    console.error('[admin-create-user]', e);
    return serverError('No se pudo crear la cuenta. Intenta de nuevo.');
  }
};
