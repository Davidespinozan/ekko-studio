import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { enviarPushAUsuario } from '../_lib/push';

/**
 * POST /reception-recurso-servicio
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { recurso_id, fuera_de_servicio: boolean, motivo? }
 *
 * Bloque F: marca/desmarca un estudio como "fuera de servicio" (temporal).
 * Al marcarlo FUERA de servicio: auto-cancela las reservas futuras confirmadas
 * de ese estudio (status='cancelada_admin') y notifica a cada miembro in-app
 * (mismo formato que cancelar_reserva_atomic). Al reactivarlo: solo limpia el
 * flag (las reservas canceladas no se restauran — los miembros re-reservan).
 *
 * Va por service_role: cancela reservas de otros miembros e inserta
 * notificaciones (cuya policy PostgREST es admin-only). Gate admin/recepcionista
 * + mismo tenant (H3). Audit_log con la cantidad de reservas afectadas.
 */

interface Body {
  recurso_id?: string;
  fuera_de_servicio?: boolean;
  motivo?: string;
}

function fechaLarga(iso: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mazatlan',
    dateStyle: 'long',
    timeStyle: 'short'
  }).format(new Date(iso));
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.recurso_id) return badRequest('recurso_id requerido');
    if (typeof body.fuera_de_servicio !== 'boolean') {
      return badRequest('fuera_de_servicio (boolean) requerido');
    }
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: caller } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, rol')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!caller || !['admin', 'recepcionista'].includes(caller.rol)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data: recurso, error: recErr } = await supabaseAdmin
      .from('recursos')
      .select('id, tenant_id, nombre, fuera_de_servicio')
      .eq('id', body.recurso_id)
      .maybeSingle();
    if (recErr) return serverError(recErr.message);
    if (!recurso) return notFound('Estudio no encontrado');
    if (recurso.tenant_id !== caller.tenant_id) {
      return forbidden('El estudio pertenece a otro tenant');
    }

    // --- Reactivar: solo limpiar el flag. ---
    if (body.fuera_de_servicio === false) {
      const { error: upErr } = await supabaseAdmin
        .from('recursos')
        .update({ fuera_de_servicio: false, fuera_de_servicio_motivo: null })
        .eq('id', recurso.id);
      if (upErr) return serverError(upErr.message);

      await writeAuditLog(supabaseAdmin, {
        tenant_id: recurso.tenant_id,
        actor_usuario_id: caller.id,
        actor_rol: caller.rol,
        accion: 'recurso_reactivado',
        target_tipo: 'recurso',
        target_id: recurso.id,
        metadata: { nombre: recurso.nombre }
      });
      return ok({ success: true, reservas_canceladas: 0 });
    }

    // --- Marcar fuera de servicio + auto-cancelar futuras + notificar. ---
    const { error: upErr } = await supabaseAdmin
      .from('recursos')
      .update({ fuera_de_servicio: true, fuera_de_servicio_motivo: motivo || null })
      .eq('id', recurso.id);
    if (upErr) return serverError(upErr.message);

    const nowIso = new Date().toISOString();
    const { data: afectadas, error: selErr } = await supabaseAdmin
      .from('reservas')
      .select('id, usuario_id, slot_inicio, folio')
      .eq('recurso_id', recurso.id)
      .eq('status', 'confirmada')
      .gt('slot_inicio', nowIso);
    if (selErr) return serverError(selErr.message);

    const lista = afectadas ?? [];
    if (lista.length > 0) {
      const ids = lista.map((r) => r.id);
      const motivoCancel = motivo
        ? `Estudio fuera de servicio: ${motivo}`
        : 'Estudio fuera de servicio';

      const { error: cancelErr } = await supabaseAdmin
        .from('reservas')
        .update({
          status: 'cancelada_admin',
          cancelada_at: nowIso,
          cancelada_por: caller.id,
          cancelada_motivo: motivoCancel,
          cancelacion_notificada_at: nowIso
        })
        .in('id', ids);
      if (cancelErr) return serverError(cancelErr.message);

      const notifs = lista.map((r) => ({
        tenant_id: recurso.tenant_id,
        usuario_id: r.usuario_id,
        tipo: 'reserva_cancelada',
        titulo: 'Tu reserva fue cancelada',
        mensaje: `El estudio "${recurso.nombre}" quedó temporalmente fuera de servicio. Tu reserva del ${fechaLarga(r.slot_inicio)} fue cancelada. Volvé a reservar cuando esté disponible.`,
        metadata: { reserva_id: r.id, motivo: 'recurso_fuera_servicio' }
      }));
      const { error: notifErr } = await supabaseAdmin.from('notificaciones').insert(notifs);
      if (notifErr) console.error('[reception-recurso-servicio] notif', notifErr.message);

      // Entrega push a cada afectado (además del aviso in-app). No-op sin VAPID.
      await Promise.all(
        notifs.map((n) =>
          enviarPushAUsuario(supabaseAdmin, n.usuario_id, {
            titulo: n.titulo,
            mensaje: n.mensaje,
            url: '/app',
            tag: 'reserva_cancelada'
          })
        )
      );
    }

    await writeAuditLog(supabaseAdmin, {
      tenant_id: recurso.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'recurso_fuera_servicio',
      target_tipo: 'recurso',
      target_id: recurso.id,
      motivo: motivo || null,
      metadata: { nombre: recurso.nombre, reservas_canceladas: lista.length }
    });

    return ok({ success: true, reservas_canceladas: lista.length });
  } catch (e) {
    console.error('[reception-recurso-servicio]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
