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
import { writeAuditLog } from '../_lib/auditLog';

/**
 * POST /reception-marcar-no-show
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { reserva_id, motivo }   // motivo OBLIGATORIO
 *
 * Marca una reserva puntual como no-show, replicando EXACTAMENTE el efecto del
 * cron `marcar_no_shows` (Bloque D): status='no_show' + no_shows_count+1 +
 * bloqueado_hasta = GREATEST(actual, now+7d). Complementa al cron nocturno —
 * recepción no espera a la noche.
 *
 * Elegibilidad: confirmada, sin check-in, slot ya terminado (slot_fin < now).
 * No exige el margen de +30min del cron: recepción actúa con conocimiento
 * directo y el efecto es idéntico (idempotente: el cron salta lo no-confirmada).
 *
 * Gobernanza (Bloque A): rol admin/recepcionista, mismo tenant (H3), motivo
 * obligatorio, audit_log inmutable. La entrada se targetea al USUARIO (la
 * penalización es sobre el miembro → visible en su historial) con el reserva_id
 * en metadata.
 */

interface Body {
  reserva_id?: string;
  motivo?: string;
}

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

    // 1. Identificar al caller y su rol/tenant.
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

    // 2. Cargar la reserva y validar.
    const { data: reserva, error: reservaErr } = await supabaseAdmin
      .from('reservas')
      .select('id, tenant_id, usuario_id, status, check_in_at, slot_fin, folio')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (reservaErr) return serverError(reservaErr.message);
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.tenant_id !== caller.tenant_id) {
      return forbidden('La reserva pertenece a otro estudio');
    }
    if (reserva.status !== 'confirmada') {
      return badRequest(`La reserva no está confirmada (estado: ${reserva.status})`);
    }
    if (reserva.check_in_at) {
      return badRequest('La reserva ya tiene check-in; no se puede marcar no-show');
    }
    if (new Date(reserva.slot_fin).getTime() >= Date.now()) {
      return badRequest('El horario de la reserva todavía no terminó');
    }

    // 3. Cargar al miembro (para el contador + bloqueo).
    const { data: miembro, error: miembroErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, no_shows_count, bloqueado_hasta')
      .eq('id', reserva.usuario_id)
      .maybeSingle();
    if (miembroErr) return serverError(miembroErr.message);
    if (!miembro) return notFound('Miembro de la reserva no encontrado');

    // Mismo cálculo que el cron: count+1 y bloqueo = max(actual, now+7d).
    const countAntes = miembro.no_shows_count ?? 0;
    const countNuevo = countAntes + 1;
    const sieteDias = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const bloqueoNuevo =
      miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta) > sieteDias
        ? miembro.bloqueado_hasta
        : sieteDias.toISOString();

    // 4. Aplicar: reserva → no_show, miembro → penalización.
    const { error: upReservaErr } = await supabaseAdmin
      .from('reservas')
      .update({ status: 'no_show' })
      .eq('id', reserva.id);
    if (upReservaErr) return serverError(upReservaErr.message);

    const { error: upMiembroErr } = await supabaseAdmin
      .from('usuarios')
      .update({ no_shows_count: countNuevo, bloqueado_hasta: bloqueoNuevo })
      .eq('id', miembro.id);
    if (upMiembroErr) return serverError(upMiembroErr.message);

    // 5. Auditoría inmutable (targeteada al usuario → visible en su historial).
    await writeAuditLog(supabaseAdmin, {
      tenant_id: reserva.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'no_show_manual',
      target_tipo: 'usuario',
      target_id: miembro.id,
      antes: { reserva_status: 'confirmada', no_shows_count: countAntes, bloqueado_hasta: miembro.bloqueado_hasta },
      despues: { reserva_status: 'no_show', no_shows_count: countNuevo, bloqueado_hasta: bloqueoNuevo },
      motivo,
      metadata: { reserva_id: reserva.id, folio: reserva.folio }
    });

    return ok({
      success: true,
      status: 'no_show',
      no_shows_count: countNuevo,
      bloqueado_hasta: bloqueoNuevo
    });
  } catch (e) {
    console.error('[reception-marcar-no-show]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
