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
import { esStaffActivo } from '../_lib/staff';
import { altaDeCuenta, esAltaOk } from '../_lib/cuentas';

/**
 * POST /reception-create-member
 * Auth: Bearer JWT de un admin o recepcionista.
 * Body: { email, password, nombre, telefono?, membresia_tier?, perfil_id? }
 *
 * Registra un MIEMBRO nuevo desde el mostrador (Recepción Plus, RP-1).
 *
 * Seguridad — por qué recepción no puede escalar:
 *  - El caller debe ser `admin` o `recepcionista` (gate de rol).
 *  - El `rol` del usuario creado está HARDCODEADO a 'miembro'. El body NO
 *    tiene campo `rol` y el código nunca lo lee → recepción jamás crea staff.
 *    La RPC lo vuelve a exigir: con rol distinto de miembro pide actor admin.
 *  - El `tenant_id` es el del actor (lo fija la RPC), nunca el del body.
 *
 * PKG-06A: la parte local va por RPC con el caller como actor explícito
 * (`cuenta_alta_preparar` → Auth → `cuenta_alta_finalizar`, ver `_lib/cuentas.ts`);
 * la auditoría `cuenta_creada` queda en la misma transacción que el perfil. Un
 * perfil existente nunca se adueña por el correo ni se borra como rollback.
 *
 * Distinta de `admin-create-user` (FIX01): esa exige rol admin y permite
 * crear cualquier rol. Esta es el contrato acotado para recepción (D5).
 */

interface CreateMemberRequest {
  email: string;
  password: string;
  nombre: string;
  telefono?: string;
  membresia_tier?: string | null;
  perfil_id?: string | null;
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
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();

    if (!esStaffActivo(callerProfile)) {
      return forbidden('Solo recepción o admin pueden registrar miembros');
    }

    // Cliente service_role (bypasea RLS para crear la cuenta).
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const email = body.email.trim().toLowerCase();
    const nombre = body.nombre.trim();
    const r = await altaDeCuenta({
      funcion: 'reception-create-member',
      admin: supabaseAdmin,
      actorId: callerProfile.id,
      email,
      password: body.password,
      nombre,
      telefono: body.telefono?.trim() || null,
      rol: 'miembro', // FIJO — recepción nunca crea staff.
      tier: body.membresia_tier ?? null,
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
        rol: 'miembro',
        status: r.status,
        // SEC-FIX (H4): el password se muestra a recepción para dárselo al
        // cliente, pero NO debe llegar a ningún log — no hacer console.log
        // de este objeto ni de la respuesta.
        password: body.password
      }
    });
  } catch (e) {
    // Loguear SOLO el Error — nunca el body ni el password.
    console.error('[reception-create-member]', e);
    return serverError('No se pudo registrar al miembro. Intenta de nuevo.');
  }
};
