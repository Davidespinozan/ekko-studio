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
 * POST /reception-create-member
 * Auth: Bearer JWT de un admin o recepcionista.
 * Body: { email, password, nombre, telefono?, membresia_tier? }
 *
 * Registra un MIEMBRO nuevo desde el mostrador (Recepción Plus, RP-1).
 *
 * Seguridad — por qué recepción no puede escalar:
 *  - El caller debe ser `admin` o `recepcionista` (gate de rol).
 *  - El `rol` del usuario creado está HARDCODEADO a 'miembro'. El body NO
 *    tiene campo `rol` y el código nunca lo lee → recepción jamás crea staff.
 *  - El `tenant_id` se toma del caller, nunca del body.
 *
 * Distinta de `admin-create-user` (FIX01): esa exige rol admin y permite
 * crear cualquier rol. Esta es el contrato acotado para recepción (D5).
 */

interface CreateMemberRequest {
  email: string;
  password: string;
  nombre: string;
  telefono?: string;
  membresia_tier?: 'basica' | 'pro' | null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Missing bearer token');
    const userToken = authHeader.slice('Bearer '.length);

    const body: CreateMemberRequest = JSON.parse(event.body || '{}');

    // Validación de input.
    if (!body.email?.includes('@')) return badRequest('Email inválido');
    if (!body.password || body.password.length < 8) {
      return badRequest('La contraseña debe tener al menos 8 caracteres');
    }
    if (!body.nombre?.trim()) return badRequest('Nombre requerido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // Cliente con el token del caller — para validar quién es.
    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } }
    });

    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    // Gate de rol: admin o recepcionista. (Recepción Plus.)
    const { data: callerProfile } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!callerProfile || !['admin', 'recepcionista'].includes(callerProfile.rol)) {
      return forbidden('Solo recepción o admin pueden registrar miembros');
    }

    const tenantId = callerProfile.tenant_id;

    // Cliente service_role (bypasea RLS para crear la cuenta).
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // 1. Crear cuenta en Auth con email confirmado (no manda email).
    const { data: newAuthUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: body.email.trim().toLowerCase(),
      password: body.password,
      email_confirm: true,
      user_metadata: {
        tenant_slug: 'ekko',
        nombre: body.nombre.trim(),
        telefono: body.telefono?.trim() || null
      }
    });

    if (createErr) {
      const msg = createErr.message.toLowerCase();
      if (msg.includes('already') || msg.includes('exists') || msg.includes('registered')) {
        return badRequest('Ya existe una cuenta con ese email');
      }
      return serverError(createErr.message);
    }

    if (!newAuthUser?.user) return serverError('No se pudo crear la cuenta');

    // 2. El trigger on_auth_user_created ya insertó la fila en `usuarios`.
    //    La actualizamos a los valores reales.
    //    rol='miembro' es FIJO — recepción nunca crea staff.
    const { error: updateErr } = await supabaseAdmin
      .from('usuarios')
      .update({
        rol: 'miembro',
        membresia_tier: body.membresia_tier ?? null,
        status: 'pendiente_pago',
        nombre: body.nombre.trim(),
        telefono: body.telefono?.trim() || null,
        tenant_id: tenantId
      })
      .eq('auth_id', newAuthUser.user.id);

    if (updateErr) {
      // Best-effort: limpiar el auth user creado para no dejar huérfano.
      await supabaseAdmin.auth.admin.deleteUser(newAuthUser.user.id);
      return serverError(`No se pudo registrar el miembro: ${updateErr.message}`);
    }

    return ok({
      success: true,
      user: {
        email: body.email.trim().toLowerCase(),
        nombre: body.nombre.trim(),
        rol: 'miembro',
        // SEC-FIX (H4): el password se muestra a recepción para dárselo al
        // cliente, pero NO debe llegar a ningún log — no hacer console.log
        // de este objeto ni de la respuesta.
        password: body.password
      }
    });
  } catch (e) {
    // Loguear SOLO el Error — nunca el body ni el password.
    console.error('[reception-create-member]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
