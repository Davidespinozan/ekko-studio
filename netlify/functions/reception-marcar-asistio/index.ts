import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, notFound, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { leerPenalizacionConfig } from '../_lib/noShow';

/**
 * POST /reception-marcar-asistio
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { reserva_id, motivo }   // motivo OBLIGATORIO
 *
 * Corrige la asistencia: el miembro SÍ vino pero nadie le hizo el check-in y el
 * cron lo marcó `no_show` (o la reserva quedó cancelada por error). Antes no
 * había forma de arreglarlo: check_in_* rechazan no_show y la card quedaba
 * deshabilitada. (Portado de SALA 5580fdb.)
 *
 *  - Acepta no_show / cancelada / cancelada_admin con slot YA iniciado.
 *  - La reserva pasa a 'completada' con check_in manual de ahora.
 *  - Si era no_show: revierte la falta (no_shows_count − 1) y, si el bloqueo
 *    vigente se debía a esa falta (el contador cae bajo el umbral), lo levanta.
 *  - Créditos: NO se re-cobran (un no_show ya consumió el crédito; una
 *    cancelada lo devolvió y así se queda — es corrección de asistencia, no
 *    un re-cobro). Mismo criterio que SALA.
 * Gobernanza: mismo tenant (H3), motivo obligatorio, audit_log inmutable.
 */

interface Body {
  reserva_id?: string;
  motivo?: string;
}

const CORREGIBLES = ['no_show', 'cancelada', 'cancelada_admin'];

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.reserva_id) return badRequest('reserva_id requerido');
    const motivo = typeof body.motivo === 'string' ? body.motivo.trim() : '';
    if (motivo.length < 3) return badRequest('Motivo obligatorio para esta acción');

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

    const { data: reserva, error: reservaErr } = await supabaseAdmin
      .from('reservas')
      .select('id, tenant_id, usuario_id, status, slot_inicio, folio')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (reservaErr) return serverError(reservaErr.message);
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.tenant_id !== caller.tenant_id) {
      return forbidden('La reserva pertenece a otro estudio');
    }
    if (reserva.status === 'completada') {
      return badRequest('Esta reserva ya tiene check-in');
    }
    if (!CORREGIBLES.includes(reserva.status)) {
      return badRequest(`Solo se corrige la asistencia de una reserva no_show o cancelada (estado: ${reserva.status})`);
    }
    if (new Date(reserva.slot_inicio).getTime() > Date.now()) {
      return badRequest('Esa sesión todavía no empieza; no se puede marcar asistencia');
    }

    const ahora = new Date().toISOString();
    const { error: upReservaErr } = await supabaseAdmin
      .from('reservas')
      .update({
        status: 'completada',
        check_in_at: ahora,
        check_in_by: caller.id,
        check_in_method: 'manual'
      })
      .eq('id', reserva.id);
    if (upReservaErr) return serverError(upReservaErr.message);

    // Revertir la falta si venía de un no_show.
    let penalizacionAntes: Record<string, unknown> | null = null;
    let penalizacionDespues: Record<string, unknown> | null = null;
    if (reserva.status === 'no_show') {
      const { data: miembro } = await supabaseAdmin
        .from('usuarios')
        .select('id, no_shows_count, bloqueado_hasta')
        .eq('id', reserva.usuario_id)
        .maybeSingle();
      if (miembro) {
        const { data: tenantRow } = await supabaseAdmin
          .from('tenants')
          .select('config')
          .eq('id', reserva.tenant_id)
          .maybeSingle();
        const cfg = leerPenalizacionConfig(tenantRow?.config ?? null);
        const countAntes = miembro.no_shows_count ?? 0;
        const countNuevo = Math.max(0, countAntes - 1);
        const bloqueoVigente = miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta).getTime() > Date.now();
        // Si al quitar esta falta ya no alcanza el umbral, el bloqueo era por ella.
        const bloqueoNuevo = bloqueoVigente && countNuevo < cfg.umbral ? null : (miembro.bloqueado_hasta ?? null);
        const { error: upMiembroErr } = await supabaseAdmin
          .from('usuarios')
          .update({ no_shows_count: countNuevo, bloqueado_hasta: bloqueoNuevo })
          .eq('id', miembro.id);
        if (upMiembroErr) return serverError(upMiembroErr.message);
        penalizacionAntes = { no_shows_count: countAntes, bloqueado_hasta: miembro.bloqueado_hasta ?? null };
        penalizacionDespues = { no_shows_count: countNuevo, bloqueado_hasta: bloqueoNuevo };
      }
    }

    await writeAuditLog(supabaseAdmin, {
      tenant_id: reserva.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'asistencia_correction',
      target_tipo: 'usuario',
      target_id: reserva.usuario_id,
      antes: { reserva_status: reserva.status, ...(penalizacionAntes ?? {}) },
      despues: { reserva_status: 'completada', ...(penalizacionDespues ?? {}) },
      motivo,
      metadata: { reserva_id: reserva.id, folio: reserva.folio }
    });

    return ok({ success: true, status: 'completada', penalizacion: penalizacionDespues });
  } catch (e) {
    console.error('[reception-marcar-asistio]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
