import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, notFound } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { enviarPushAUsuario, clasificarPush, registrarResultadoPush } from '../_lib/push';
import { leerPenalizacionConfig, calcularPenalizacionNoShow, mensajeNoShow } from '../_lib/noShow';
import { esStaffActivo } from '../_lib/staff';

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

/** Tolerancia de llegada = ventana de check-in del estudio (Admin → Reglas); 15 min por defecto. */
function leerToleranciaMin(config: unknown): number {
  const v = Number((config as { reserva?: { ventana_check_in_min?: unknown } } | null)?.reserva?.ventana_check_in_min);
  return Number.isFinite(v) && v >= 0 && v <= 180 ? v : 15;
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
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(caller)) {
      return forbidden('Solo recepción o admin pueden hacer esto');
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // 2. Cargar la reserva y validar.
    const { data: reserva, error: reservaErr } = await supabaseAdmin
      .from('reservas')
      .select('id, tenant_id, usuario_id, status, check_in_at, slot_inicio, slot_fin, folio')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (reservaErr) return errorInterno('reception-marcar-no-show', reservaErr);
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

    // 3. Cargar al miembro (para el contador + bloqueo).
    const { data: miembro, error: miembroErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, no_shows_count, bloqueado_hasta')
      .eq('id', reserva.usuario_id)
      .maybeSingle();
    if (miembroErr) return errorInterno('reception-marcar-no-show', miembroErr);
    if (!miembro) return notFound('Miembro de la reserva no encontrado');

    // 3b. Reglas del tenant (Admin → Reglas → Penalizaciones). Mismo cálculo
    //     que el cron `marcar_no_shows`: 0 días = solo registrar, sin bloquear.
    const { data: tenantRow, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('config')
      .eq('id', reserva.tenant_id)
      .maybeSingle();
    if (tenantErr) return errorInterno('reception-marcar-no-show', tenantErr);

    // ¿Ya se le puede dar por ausente? Antes había que esperar a que TERMINARA la
    // sesión (slot_fin): durante esa hora el estudio quedaba bloqueado —ni se
    // podía marcar la falta ni cancelar (eso exige slot_inicio futuro)— y un
    // walk-in recibía "horario ocupado" con el estudio vacío. En renta de 1
    // reserva por slot eso es una hora de estudio perdida por cada ausente.
    // Ahora basta con que pase la tolerancia de llegada (la ventana de check-in).
    const toleranciaMin = leerToleranciaMin(tenantRow?.config ?? null);
    const desde = new Date(reserva.slot_inicio ?? reserva.slot_fin).getTime() + toleranciaMin * 60_000;
    if (Date.now() < desde) {
      return badRequest(
        new Date(reserva.slot_inicio ?? reserva.slot_fin).getTime() > Date.now()
          ? 'La sesión todavía no empieza'
          : `Espera la tolerancia de llegada (${toleranciaMin} min desde el inicio) antes de marcar la falta`
      );
    }

    const cfg = leerPenalizacionConfig(tenantRow?.config ?? null);
    const countAntes = miembro.no_shows_count ?? 0;
    const pen = calcularPenalizacionNoShow({
      countAntes,
      bloqueadoHasta: miembro.bloqueado_hasta ?? null,
      cfg
    });
    const countNuevo = pen.countNuevo;
    const bloqueoNuevo = pen.bloqueadoHasta;

    // 4. Aplicar: reserva → no_show, miembro → penalización.
    // Condicionado a que SIGA confirmada: si el cron de no-shows o un doble
    // envío se adelantaron, no se penaliza dos veces (antes el UPDATE era ciego y
    // el contador se recalculaba desde un valor viejo).
    const { data: marcada, error: upReservaErr } = await supabaseAdmin
      .from('reservas')
      .update({ status: 'no_show' })
      .eq('id', reserva.id)
      .eq('status', 'confirmada')
      .select('id');
    if (upReservaErr) return errorInterno('reception-marcar-no-show', upReservaErr);
    if (!marcada || marcada.length === 0) {
      return badRequest('La reserva ya cambió de estado; recarga la pantalla.');
    }

    const { error: upMiembroErr } = await supabaseAdmin
      .from('usuarios')
      .update({ no_shows_count: countNuevo, bloqueado_hasta: bloqueoNuevo })
      .eq('id', miembro.id);
    if (upMiembroErr) return errorInterno('reception-marcar-no-show', upMiembroErr);

    // 4b. Avisar al miembro (in-app + push, best-effort): que se entere de la
    //     falta y del bloqueo ahora, no cuando intente reservar.
    try {
      const aviso = mensajeNoShow({ folio: reserva.folio, resultado: pen, cfg });
      const { data: creada, error: notifErr } = await supabaseAdmin.from('notificaciones').insert({
        tenant_id: reserva.tenant_id,
        usuario_id: miembro.id,
        tipo: 'no_show',
        titulo: aviso.titulo,
        mensaje: aviso.mensaje,
        metadata: { reserva_id: reserva.id, folio: reserva.folio, bloqueado_hasta: bloqueoNuevo },
        // PKG-03A: el push sale aquí mismo; el lease evita que cron-push lo repita.
        push_intento_at: new Date().toISOString()
      }).select('id').maybeSingle();
      if (notifErr) console.error('[reception-marcar-no-show] notificación', notifErr.message);
      const r = await enviarPushAUsuario(supabaseAdmin, miembro.id, {
        titulo: aviso.titulo,
        mensaje: aviso.mensaje,
        url: '/app/reservas',
        tag: 'no_show'
      });
      if (creada?.id) await registrarResultadoPush(supabaseAdmin, [creada.id], clasificarPush(r));
    } catch (e) {
      console.error('[reception-marcar-no-show] aviso', e instanceof Error ? e.message : e);
    }

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
      metadata: { reserva_id: reserva.id, folio: reserva.folio, umbral: cfg.umbral, bloqueo_dias: cfg.bloqueo_dias }
    });

    return ok({
      success: true,
      status: 'no_show',
      no_shows_count: countNuevo,
      bloqueado_hasta: bloqueoNuevo
    });
  } catch (e) {
    console.error('[reception-marcar-no-show]', e);
    return errorInterno('reception-marcar-no-show', e);
  }
};
