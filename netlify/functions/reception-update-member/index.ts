import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /reception-update-member
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: {
 *   usuario_id: string,
 *   nombre?, telefono?, email?,          // datos de contacto
 *   status?: 'activo' | 'suspendido' | 'pendiente_pago',
 *   membresia_tier?: 'basica' | 'pro' | null,
 *   unblock?: boolean,                    // bloqueado_hasta=null + no_shows_count=0
 *   avatar?: { base64: string, contentType: string }
 * }
 *
 * Front-desk: recepción atiende al cliente EN PERSONA y resuelve imprevistos
 * de su cuenta (foto, datos, desbloqueo, status, plan). El trigger SEC-FIX C2
 * bloquea estos cambios desde el cliente; por eso pasan por esta función con
 * service_role (current_user='service_role' ⇒ el trigger no aplica).
 *
 * Seguridad:
 *  - Caller debe ser admin/recepcionista (gate de rol).
 *  - El target DEBE ser del MISMO tenant que el caller.
 *  - NO se puede tocar `rol` ni `tenant_id` (no están en el patch).
 *  - Cada cambio se registra en `notas_admin` (auditoría para el dueño).
 */

const STATUS_PERMITIDOS = ['activo', 'suspendido', 'pendiente_pago'] as const;
const TIERS_PERMITIDOS = ['basica', 'pro'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Body {
  usuario_id?: string;
  nombre?: string;
  telefono?: string;
  email?: string;
  status?: string;
  membresia_tier?: string | null;
  unblock?: boolean;
  avatar?: { base64?: string; contentType?: string };
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  return 'jpg';
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

    // 1. Identificar al caller y su rol/tenant.
    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: caller } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol, nombre')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!caller || !['admin', 'recepcionista'].includes(caller.rol)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // 2. Cargar al miembro target y validar que sea del MISMO tenant.
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, auth_id, tenant_id, nombre, email, telefono, status, membresia_tier, bloqueado_hasta, no_shows_count, notas_admin')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro es de otro tenant');

    const patch: Record<string, unknown> = {};
    const cambios: string[] = [];

    // --- Datos de contacto ---
    if (typeof body.nombre === 'string' && body.nombre.trim() && body.nombre.trim() !== target.nombre) {
      patch.nombre = body.nombre.trim();
      cambios.push('nombre');
    }
    if (typeof body.telefono === 'string' && body.telefono.trim() !== (target.telefono ?? '')) {
      patch.telefono = body.telefono.trim() || null;
      cambios.push('teléfono');
    }

    // --- Email (toca auth + usuarios) ---
    let emailNuevo: string | null = null;
    if (typeof body.email === 'string' && body.email.trim()) {
      emailNuevo = body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(emailNuevo)) return badRequest('Email inválido');
      if (emailNuevo === target.email) emailNuevo = null;
    }

    // --- Status (sensible) ---
    if (typeof body.status === 'string' && body.status !== target.status) {
      if (!(STATUS_PERMITIDOS as readonly string[]).includes(body.status)) {
        return badRequest(`Status no permitido: ${body.status}`);
      }
      patch.status = body.status;
      cambios.push(`status→${body.status}`);
    }

    // --- Tier (sensible / monetización) ---
    if (body.membresia_tier !== undefined && body.membresia_tier !== target.membresia_tier) {
      if (body.membresia_tier !== null && !(TIERS_PERMITIDOS as readonly string[]).includes(body.membresia_tier)) {
        return badRequest(`Plan no permitido: ${body.membresia_tier}`);
      }
      patch.membresia_tier = body.membresia_tier;
      cambios.push(`plan→${body.membresia_tier ?? 'sin plan'}`);
    }

    // --- Desbloqueo (sensible) ---
    if (body.unblock && (target.bloqueado_hasta || (target.no_shows_count ?? 0) > 0)) {
      patch.bloqueado_hasta = null;
      patch.no_shows_count = 0;
      cambios.push('desbloqueo');
    }

    // --- Avatar (sube a storage con service_role, fija avatar_url) ---
    if (body.avatar?.base64 && body.avatar.contentType) {
      const buffer = Buffer.from(body.avatar.base64, 'base64');
      if (buffer.length > 4 * 1024 * 1024) return badRequest('La imagen es muy grande (máx 4MB)');
      const ext = extFromContentType(body.avatar.contentType);
      const path = `${target.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from('avatars')
        .upload(path, buffer, { contentType: body.avatar.contentType, upsert: true });
      if (upErr) return serverError(`No se pudo subir la foto: ${upErr.message}`);
      const { data: pub } = supabaseAdmin.storage.from('avatars').getPublicUrl(path);
      patch.avatar_url = pub.publicUrl;
      cambios.push('foto');
    }

    // Cambio de email vía Auth Admin.
    if (emailNuevo) {
      const { error: authEmailErr } = await supabaseAdmin.auth.admin.updateUserById(target.auth_id, {
        email: emailNuevo,
        email_confirm: true
      });
      if (authEmailErr) {
        const m = authEmailErr.message.toLowerCase();
        if (m.includes('already') || m.includes('exists') || m.includes('registered')) {
          return badRequest('Ya existe una cuenta con ese email');
        }
        return serverError(`No se pudo cambiar el email: ${authEmailErr.message}`);
      }
      patch.email = emailNuevo;
      cambios.push('email');
    }

    if (cambios.length === 0) return ok({ success: true, sin_cambios: true });

    // Auditoría: anexar línea a notas_admin.
    const fecha = new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
    const quien = caller.rol === 'admin' ? 'admin' : 'recepción';
    const linea = `[${fecha} · ${quien}] ${cambios.join(', ')}`;
    patch.notas_admin = target.notas_admin ? `${target.notas_admin}\n${linea}` : linea;

    const { error: updErr } = await supabaseAdmin
      .from('usuarios')
      .update(patch)
      .eq('id', target.id);
    if (updErr) return serverError(updErr.message);

    return ok({ success: true, cambios, avatar_url: patch.avatar_url ?? null });
  } catch (e) {
    console.error('[reception-update-member]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
