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
import { esStaffActivo, puedeOperarSobre } from '../_lib/staff';
import { ejecutarOperacionesSuscripcion, type ResumenOperaciones } from '../_lib/operacionesSuscripcion';
import { reportarErrorServidor } from '../_lib/sentry';
import { conflicto, esCorreoYaRegistrado, respuestaErrorRpc } from '../_lib/cuentas';

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
 *   motivo?: string                       // OBLIGATORIO si cambia status/unblock
 * }
 *
 * PKG-06A · orden y honestidad:
 *  1. Foto → Storage (externo; si falla, nada cambió).
 *  2. RPC `staff_actualizar_cuenta`: nombre/teléfono/status/sanción/desbloqueo/foto
 *     + restauración de revocado (R1, solo admin) + auditoría con actor, en UNA
 *     transacción. Si falla, nada local cambió.
 *  3. Correo: primero Auth (es el login), después la copia local por la misma RPC.
 *     Si Auth falla, la copia local no se toca y se responde qué SÍ se guardó
 *     (409 `parcial`); si Auth aceptó y la copia local falla, se dice (500
 *     `parcial`) y el reintento converge (Auth ya tiene el correo nuevo).
 *  4. Operaciones de cobro (R2-B/EKKO-138/02H): las crean los triggers en la
 *     transacción del paso 2; aquí solo se ejecutan. Si Stripe falla, la sanción
 *     NO se deshace: la operación queda `fallida`, visible en Operación.
 *
 * Sanción administrativa (Fase 1 identidad): `status='suspendido'` desde aquí es
 * una SANCIÓN (sancionado_at + motivo); `activo` o `pendiente_pago` la levantan.
 * La revocación es persistente: solo un admin la restaura (`restaurar_acceso_revocado`).
 */

const STATUS_PERMITIDOS = ['activo', 'suspendido', 'pendiente_pago'] as const;
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

type ResultadoRpc = { success: boolean; sin_cambios: boolean; cambios: string[]; status: string; avatar_url?: string | null };

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

    // 2. Cargar al target: mismo tenant y alcance de recepción (la RPC lo vuelve a
    //    exigir; aquí evita subir una foto para una operación que será rechazada).
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, auth_id, tenant_id, rol, email, status')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError('No se pudo cargar la cuenta. Intenta de nuevo.');
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro es de otro tenant');
    if (!puedeOperarSobre(caller, target)) {
      return forbidden('Solo un admin puede modificar las cuentas del equipo');
    }

    // 3. Validación de entrada (la regla vive en la RPC; esto da 400 tempranos).
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
    const statusNuevo = typeof body.status === 'string' && body.status !== target.status ? body.status : null;
    if (statusNuevo !== null && !(STATUS_PERMITIDOS as readonly string[]).includes(statusNuevo)) {
      return badRequest(`Status no permitido: ${statusNuevo}`);
    }
    if (body.membresia_tier !== undefined) {
      return badRequest('El plan no se cambia desde "Editar datos": actívalo con cobro desde la tarjeta de membresía');
    }
    if ((statusNuevo !== null || body.unblock) && motivo.length < 3) {
      return badRequest('Motivo obligatorio para esta acción');
    }
    const restaurarRevocado = target.status === 'revocado' && statusNuevo !== null && statusNuevo !== 'suspendido';
    if (restaurarRevocado && caller.rol !== 'admin') {
      return forbidden('Solo un admin puede restaurar un acceso revocado');
    }
    let emailNuevo: string | null = null;
    if (typeof body.email === 'string' && body.email.trim()) {
      emailNuevo = body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(emailNuevo)) return badRequest('Email inválido');
      if (emailNuevo === (target.email ?? '').toLowerCase()) emailNuevo = null;
    }

    // 4. Foto → Storage (externo, antes de la transacción local).
    let avatarUrl: string | null = null;
    if (body.avatar?.base64 && body.avatar.contentType) {
      const buffer = Buffer.from(body.avatar.base64, 'base64');
      if (buffer.length > 4 * 1024 * 1024) return badRequest('La imagen es muy grande (máx 4MB)');
      const ext = extFromContentType(body.avatar.contentType);
      const path = `${target.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabaseAdmin.storage
        .from('avatars')
        .upload(path, buffer, { contentType: body.avatar.contentType, upsert: true });
      if (upErr) {
        await reportarErrorServidor('reception-update-member', new Error(upErr.message), { paso: 'storage.upload', usuario_id: target.id });
        return serverError('No se pudo subir la foto. Intenta de nuevo.');
      }
      avatarUrl = supabaseAdmin.storage.from('avatars').getPublicUrl(path).data.publicUrl;
    }

    // 5. Parte local (sin el correo): UNA transacción con actor y auditoría.
    const cambiosLocales: Record<string, unknown> = {};
    if (typeof body.nombre === 'string' && body.nombre.trim()) cambiosLocales.nombre = body.nombre.trim();
    if (typeof body.telefono === 'string') cambiosLocales.telefono = body.telefono.trim();
    if (statusNuevo !== null) cambiosLocales.status = statusNuevo;
    if (body.unblock) cambiosLocales.unblock = true;
    if (avatarUrl) cambiosLocales.avatar_url = avatarUrl;

    let cambios: string[] = [];
    let statusFinal: string = target.status;
    if (Object.keys(cambiosLocales).length > 0) {
      const { data, error } = await supabaseAdmin.rpc('staff_actualizar_cuenta', {
        p_actor_id: caller.id,
        p_usuario_id: target.id,
        p_cambios: cambiosLocales,
        p_motivo: motivo || null
      });
      if (error) return respuestaErrorRpc('reception-update-member', error, { usuario_id: target.id, paso: 'local' });
      const r = (data ?? {}) as ResultadoRpc;
      cambios = Array.isArray(r.cambios) ? r.cambios : [];
      statusFinal = r.status ?? statusFinal;
    }

    // 6. Correo: Auth primero (es el login), luego la copia local.
    let parcial: Record<string, unknown> | null = null;
    if (emailNuevo) {
      const { error: authEmailErr } = await supabaseAdmin.auth.admin.updateUserById(target.auth_id, {
        email: emailNuevo,
        email_confirm: true
      });
      if (authEmailErr) {
        const porQue = esCorreoYaRegistrado(authEmailErr.message)
          ? 'ya existe una cuenta con ese email'
          : 'el proveedor de acceso no aceptó el cambio';
        if (cambios.length === 0) {
          return esCorreoYaRegistrado(authEmailErr.message)
            ? badRequest('Ya existe una cuenta con ese email')
            : serverError('No se pudo cambiar el email. Intenta de nuevo.');
        }
        // Lo local SÍ quedó; el correo no. Se dice tal cual.
        return conflicto(
          `Se guardó ${cambios.join(', ')}, pero el correo de acceso no se pudo cambiar: ${porQue}. Vuelve a intentar solo el correo.`,
          { parcial: { aplicado: cambios, email: 'no_aplicado' } }
        );
      }
      const { data, error } = await supabaseAdmin.rpc('staff_actualizar_cuenta', {
        p_actor_id: caller.id,
        p_usuario_id: target.id,
        p_cambios: { email: emailNuevo },
        p_motivo: motivo || null
      });
      if (error) {
        // Auth ya tiene el correo nuevo; la copia local no. El reintento converge.
        await reportarErrorServidor('reception-update-member', new Error(error.message), { usuario_id: target.id, paso: 'email_local' });
        parcial = { aplicado: cambios, email: 'auth_actualizado_perfil_pendiente' };
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'El correo de acceso ya cambió, pero el perfil no se actualizó. Vuelve a guardar para sincronizarlo.',
            seguro: true,
            parcial
          })
        };
      }
      const r = (data ?? {}) as ResultadoRpc;
      cambios = cambios.concat(Array.isArray(r.cambios) ? r.cambios : []);
    }

    if (cambios.length === 0) return ok({ success: true, sin_cambios: true });

    // 7. R2-B (PKG-01P): sancionar SUSPENDE el cobro y levantar la sanción lo
    //    REANUDA. La operación ya quedó en stripe_operaciones_suscripcion (trigger,
    //    misma transacción); aquí solo se ejecuta.
    let cobroStripe: ResumenOperaciones | null = null;
    if (statusNuevo !== null) {
      try {
        cobroStripe = await ejecutarOperacionesSuscripcion(supabaseAdmin, { usuarioId: target.id });
      } catch (e) {
        await reportarErrorServidor('reception-update-member', e, { paso: 'operaciones_suscripcion', usuario_id: target.id });
      }
    }

    return ok({ success: true, cambios, status: statusFinal, avatar_url: avatarUrl, cobro_stripe: cobroStripe });
  } catch (e) {
    console.error('[reception-update-member]', e);
    return serverError('No se pudo guardar. Intenta de nuevo.');
  }
};
