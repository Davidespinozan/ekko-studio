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
import { esStaffActivo, puedeOperarSobre } from '../_lib/staff';
import { ejecutarOperacionesSuscripcion, type ResumenOperaciones } from '../_lib/operacionesSuscripcion';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /reception-update-member
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: {
 *   usuario_id: string,
 *   nombre?, telefono?, email?,          // datos de contacto
 *   status?: 'activo' | 'suspendido' | 'pendiente_pago',
 *   membresia_tier?: RECHAZADO (400). El plan se activa con cobro (activar_membresia);
 *                    esta ruta no concede ni quita acceso comercial (Fase 1 identidad).
 *   unblock?: boolean,                    // bloqueado_hasta=null (NO resetea no_shows_count — B4)
 *   avatar?: { base64: string, contentType: string },
 *   motivo?: string                       // OBLIGATORIO si cambia status/tier/unblock
 * }
 *
 * Sanción administrativa (Fase 1 identidad, 2026-09-25): `status='suspendido'`
 * desde aquí es una SANCIÓN del estudio → fija usuarios.sancionado_at + motivo;
 * mientras exista, ninguna activación/cobro/reanudación devuelve el acceso
 * (trigger trg_sancion_manda). `activo` o `pendiente_pago` la levantan.
 *
 * Front-desk: recepción atiende al cliente EN PERSONA y resuelve imprevistos
 * de su cuenta (foto, datos, desbloqueo, status). El trigger SEC-FIX C2
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
// El plan se valida contra `tiers` del tenant (activo=true), NO contra una lista
// fija: la lista vieja ['basica','pro'] dejó a recepción/admin sin poder asignar
// ningún plan real (starter/creador/pro-pack/esencial/premium…).
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
      .select('id, tenant_id, rol, nombre, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(caller)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // 2. Cargar al miembro target y validar que sea del MISMO tenant.
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, auth_id, tenant_id, rol, nombre, email, telefono, status, membresia_tier, bloqueado_hasta, no_shows_count, sancionado_at')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro es de otro tenant');
    // Escalada: recepción solo edita a MIEMBROS. Sin este guard un recepcionista
    // podía cambiarle el email de acceso a un admin (email_confirm: true) y
    // quedarse con su cuenta vía /recuperar, o suspenderlo.
    if (!puedeOperarSobre(caller, target)) {
      return forbidden('Solo un admin puede modificar las cuentas del equipo');
    }

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

    // El plan NO se edita aquí: `membresia_tier` es una copia derivada de
    // `membresias` y escribirla a mano concedía (o quitaba) acceso sin cobro.
    if (body.membresia_tier !== undefined) {
      return badRequest('El plan no se cambia desde "Editar datos": actívalo con cobro desde la tarjeta de membresía');
    }

    const unblockAplica = Boolean(
      body.unblock && (target.bloqueado_hasta || (target.no_shows_count ?? 0) > 0)
    );

    // --- Motivo obligatorio en acciones sensibles (status / tier / desbloqueo) ---
    const requiereMotivo = statusNuevo !== null || unblockAplica;
    if (requiereMotivo && motivo.length < 3) {
      return badRequest('Motivo obligatorio para esta acción');
    }

    // --- Revocación (F2 · R1): es PERSISTENTE. El trigger trg_sancion_manda no
    // deja que un UPDATE normal la levante; la única vía es la RPC explícita
    // restaurar_acceso_revocado, y solo para un ADMIN.
    const restaurarRevocado =
      target.status === 'revocado' && statusNuevo !== null && statusNuevo !== 'suspendido';
    if (restaurarRevocado && caller.rol !== 'admin') {
      return forbidden('Solo un admin puede restaurar un acceso revocado');
    }

    // --- Status ---
    if (statusNuevo !== null) {
      if (!restaurarRevocado) patch.status = statusNuevo;
      // Suspender desde el mostrador = SANCIÓN administrativa; activar o dejar
      // pendiente de pago = levantarla. Va en el MISMO UPDATE: el trigger
      // trg_sancion_manda fuerza `suspendido` mientras sancionado_at no sea NULL.
      const sancionar = statusNuevo === 'suspendido';
      patch.sancionado_at = sancionar ? new Date().toISOString() : null;
      patch.sancion_motivo = sancionar ? motivo : null;
      cambios.push(`status→${statusNuevo}`);
      auditEntries.push({
        ...baseAudit,
        accion: 'status_change',
        antes: { status: target.status, sancionado: target.sancionado_at != null },
        despues: { status: statusNuevo, sancionado: sancionar },
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
      // La foto es parte del gate de check-in (identidad_completa = foto + datos +
      // INE). Se recalcula aquí para no dejar bloqueado a un miembro con ficha ya
      // completa cuya foto se subió por este endpoint (antes solo lo recalculaba
      // reception-datos-identidad, así que el orden de captura importaba).
      const { data: dp } = await supabaseAdmin
        .from('usuarios_datos_privados')
        .select('fecha_nacimiento, domicilio, ine_foto_path')
        .eq('usuario_id', target.id)
        .maybeSingle();
      patch.identidad_completa =
        !!pub.publicUrl && !!dp?.fecha_nacimiento && !!dp?.domicilio && !!dp?.ine_foto_path;
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
    if (Object.keys(patch).length > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('usuarios')
        .update(patch)
        .eq('id', target.id);
      if (updErr) return serverError(updErr.message);
    }

    // Restaurar una revocación: DESPUÉS del patch (que ya levantó la sanción si
    // correspondía), por la RPC explícita y auditada.
    if (restaurarRevocado) {
      const { error: restErr } = await supabaseAdmin.rpc('restaurar_acceso_revocado', {
        p_usuario_id: target.id,
        p_actor_id: caller.id,
        p_status: statusNuevo,
        p_motivo: motivo
      });
      if (restErr) return serverError(restErr.message);
    }

    // El audit registra el estado REAL persistido: los triggers pueden dejar
    // 'suspendido' (sanción) o 'revocado' aunque se haya pedido otro.
    if (statusNuevo !== null) {
      const fin = await supabaseAdmin.from('usuarios').select('status').eq('id', target.id).maybeSingle();
      const statusFinal = (fin?.data as { status?: string } | null)?.status ?? statusNuevo;
      for (const entry of auditEntries) {
        if (entry.accion === 'status_change' && entry.despues) {
          entry.despues = { ...entry.despues, status: statusFinal };
        }
      }
    }

    // Auditoría inmutable — una entrada por acción. NO rompe la respuesta si falla.
    for (const entry of auditEntries) {
      await writeAuditLog(supabaseAdmin, entry);
    }

    // R2-B (PKG-01P): sancionar SUSPENDE el cobro de Stripe y levantar la sanción
    // lo REANUDA (si todo sigue válido). La operación ya quedó en
    // stripe_operaciones_suscripcion (trigger, misma transacción del UPDATE);
    // aquí solo se ejecuta. Si Stripe falla, la sanción NO se deshace: la
    // operación queda `fallida` con aviso al admin y se reintenta.
    let cobroStripe: ResumenOperaciones | null = null;
    if (statusNuevo !== null) {
      try {
        cobroStripe = await ejecutarOperacionesSuscripcion(supabaseAdmin, { usuarioId: target.id });
      } catch (e) {
        await reportarErrorServidor('reception-update-member', e, { paso: 'operaciones_suscripcion', usuario_id: target.id });
      }
    }

    return ok({ success: true, cambios, avatar_url: patch.avatar_url ?? null, cobro_stripe: cobroStripe });
  } catch (e) {
    console.error('[reception-update-member]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
