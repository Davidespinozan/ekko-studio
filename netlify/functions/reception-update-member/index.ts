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
import { writeAuditLog, type AuditEntry } from '../_lib/auditLog';

/**
 * POST /reception-update-member
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: {
 *   usuario_id: string,
 *   nombre?, telefono?, email?,          // datos de contacto
 *   status?: 'activo' | 'suspendido' | 'pendiente_pago',
 *   membresia_tier?: 'basica' | 'pro' | null,
 *   unblock?: boolean,                    // bloqueado_hasta=null (NO resetea no_shows_count — B4)
 *   avatar?: { base64: string, contentType: string },
 *   motivo?: string                       // OBLIGATORIO si cambia status/tier/unblock
 * }
 *
 * Front-desk: recepción atiende al cliente EN PERSONA y resuelve imprevistos
 * de su cuenta (foto, datos, desbloqueo, status, plan). El trigger SEC-FIX C2
 * bloquea estos cambios desde el cliente; por eso pasan por esta función con
 * service_role (current_user='service_role' ⇒ el trigger no aplica).
 *
 * Seguridad / gobernanza (Bloque A):
 *  - Caller debe ser admin/recepcionista (gate de rol).
 *  - El target DEBE ser del MISMO tenant que el caller.
 *  - NO se puede tocar `rol` ni `tenant_id` (no están en el patch).
 *  - status/tier/desbloqueo exigen `motivo` (≥3 chars) → 400 si falta.
 *  - Cada acción se registra en `audit_log` (insert-only, NO en notas_admin:
 *    ese campo era borrable por admin — B1/B2). notas_admin queda solo humano.
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
  motivo?: string;
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
      .select('id, auth_id, tenant_id, nombre, email, telefono, status, membresia_tier, bloqueado_hasta, no_shows_count')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro es de otro tenant');

    const patch: Record<string, unknown> = {};
    const cambios: string[] = [];
    const auditEntries: AuditEntry[] = [];

    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';

    const baseAudit = {
      tenant_id: target.tenant_id as string,
      actor_usuario_id: caller.id as string,
      actor_rol: caller.rol as string,
      target_tipo: 'usuario',
      target_id: target.id as string
    };

    // --- Datos de contacto (no requieren motivo) ---
    const contactoAntes: Record<string, unknown> = {};
    const contactoDespues: Record<string, unknown> = {};
    if (typeof body.nombre === 'string' && body.nombre.trim() && body.nombre.trim() !== target.nombre) {
      patch.nombre = body.nombre.trim();
      cambios.push('nombre');
      contactoAntes.nombre = target.nombre;
      contactoDespues.nombre = body.nombre.trim();
    }
    if (typeof body.telefono === 'string' && body.telefono.trim() !== (target.telefono ?? '')) {
      patch.telefono = body.telefono.trim() || null;
      cambios.push('teléfono');
      contactoAntes.telefono = target.telefono ?? null;
      contactoDespues.telefono = body.telefono.trim() || null;
    }

    // --- Email (toca auth + usuarios; es dato de contacto, sin motivo) ---
    let emailNuevo: string | null = null;
    if (typeof body.email === 'string' && body.email.trim()) {
      emailNuevo = body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(emailNuevo)) return badRequest('Email inválido');
      if (emailNuevo === target.email) emailNuevo = null;
    }

    // --- Detección de cambios sensibles (requieren motivo) ---
    const statusNuevo =
      typeof body.status === 'string' && body.status !== target.status ? body.status : null;
    if (statusNuevo !== null && !(STATUS_PERMITIDOS as readonly string[]).includes(statusNuevo)) {
      return badRequest(`Status no permitido: ${statusNuevo}`);
    }

    const tierCambia =
      body.membresia_tier !== undefined && body.membresia_tier !== target.membresia_tier;
    if (
      tierCambia &&
      body.membresia_tier !== null &&
      !(TIERS_PERMITIDOS as readonly string[]).includes(body.membresia_tier as string)
    ) {
      return badRequest(`Plan no permitido: ${body.membresia_tier}`);
    }

    const unblockAplica = Boolean(
      body.unblock && (target.bloqueado_hasta || (target.no_shows_count ?? 0) > 0)
    );

    // --- Motivo obligatorio en acciones sensibles (status / tier / desbloqueo) ---
    const requiereMotivo = statusNuevo !== null || tierCambia || unblockAplica;
    if (requiereMotivo && motivo.length < 3) {
      return badRequest('Motivo obligatorio para esta acción');
    }

    // --- Status ---
    if (statusNuevo !== null) {
      patch.status = statusNuevo;
      cambios.push(`status→${statusNuevo}`);
      auditEntries.push({
        ...baseAudit,
        accion: 'status_change',
        antes: { status: target.status },
        despues: { status: statusNuevo },
        motivo
      });
    }

    // --- Tier (sensible / monetización) ---
    if (tierCambia) {
      const tierNuevo = (body.membresia_tier ?? null) as string | null;
      patch.membresia_tier = tierNuevo;
      cambios.push(`plan→${tierNuevo ?? 'sin plan'}`);
      auditEntries.push({
        ...baseAudit,
        accion: 'tier_change',
        antes: { membresia_tier: target.membresia_tier },
        despues: { membresia_tier: tierNuevo },
        motivo
      });
    }

    // --- Desbloqueo (B4: levanta el bloqueo pero NO resetea no_shows_count) ---
    if (unblockAplica) {
      patch.bloqueado_hasta = null;
      cambios.push('desbloqueo');
      auditEntries.push({
        ...baseAudit,
        accion: 'unblock',
        antes: { bloqueado_hasta: target.bloqueado_hasta, no_shows_count: target.no_shows_count ?? 0 },
        despues: { bloqueado_hasta: null, no_shows_count: target.no_shows_count ?? 0 },
        motivo
      });
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
      auditEntries.push({
        ...baseAudit,
        accion: 'avatar_change',
        despues: { avatar_url: pub.publicUrl }
      });
    }

    // --- Cambio de email vía Auth Admin (dato de contacto) ---
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
      contactoAntes.email = target.email;
      contactoDespues.email = emailNuevo;
    }

    if (cambios.length === 0) return ok({ success: true, sin_cambios: true });

    // Entrada de auditoría de contacto (si cambió algo de contacto). El motivo
    // es opcional acá — los cambios de contacto son operativos triviales.
    if (Object.keys(contactoDespues).length > 0) {
      auditEntries.push({
        ...baseAudit,
        accion: 'contact_change',
        antes: contactoAntes,
        despues: contactoDespues,
        motivo: motivo || null
      });
    }

    // B1/B2: la auditoría ya NO vive en notas_admin (campo borrable por admin).
    // Va a audit_log (insert-only). notas_admin vuelve a ser solo notas humanas.
    const { error: updErr } = await supabaseAdmin
      .from('usuarios')
      .update(patch)
      .eq('id', target.id);
    if (updErr) return serverError(updErr.message);

    // Auditoría inmutable — una entrada por acción. NO rompe la respuesta si falla.
    for (const entry of auditEntries) {
      await writeAuditLog(supabaseAdmin, entry);
    }

    return ok({ success: true, cambios, avatar_url: patch.avatar_url ?? null });
  } catch (e) {
    console.error('[reception-update-member]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
