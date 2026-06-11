import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';

/**
 * POST /reception-corregir-checkin
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { reserva_id, motivo }   // motivo OBLIGATORIO
 *
 * Deshace un check-in mal hecho (miembro equivocado, marcado sin presentarse):
 * status vuelve a 'confirmada' y se limpian check_in_at / check_in_by /
 * check_in_method. Limitado al MISMO DÍA (zona America/Mazatlan) — algo más
 * viejo se escala a admin (no es el caso común; recepción corrige en caliente).
 *
 * Gobernanza (Bloque A): rol admin/recepcionista, mismo tenant (H3), motivo
 * obligatorio, audit_log inmutable (targeteado al usuario → historial).
 */

interface Body {
  reserva_id?: string;
  motivo?: string;
}

/** Día de pared (YYYY-MM-DD) en America/Mazatlan, para el límite "mismo día". */
function diaMazatlan(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mazatlan' }).format(new Date(iso));
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
      .select('id, tenant_id, usuario_id, status, check_in_at, check_in_method, folio')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (reservaErr) return serverError(reservaErr.message);
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.tenant_id !== caller.tenant_id) {
      return forbidden('La reserva pertenece a otro estudio');
    }
    if (!reserva.check_in_at) {
      return badRequest('La reserva no tiene check-in que corregir');
    }
    if (diaMazatlan(reserva.check_in_at) !== diaMazatlan(new Date().toISOString())) {
      return badRequest('Solo se puede corregir un check-in del mismo día. Escalá a admin.');
    }

    const { error: upErr } = await supabaseAdmin
      .from('reservas')
      .update({
        status: 'confirmada',
        check_in_at: null,
        check_in_by: null,
        check_in_method: null
      })
      .eq('id', reserva.id);
    if (upErr) return serverError(upErr.message);

    await writeAuditLog(supabaseAdmin, {
      tenant_id: reserva.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'checkin_correction',
      target_tipo: 'usuario',
      target_id: reserva.usuario_id,
      antes: { status: reserva.status, check_in_at: reserva.check_in_at, check_in_method: reserva.check_in_method },
      despues: { status: 'confirmada', check_in_at: null, check_in_method: null },
      motivo,
      metadata: { reserva_id: reserva.id, folio: reserva.folio }
    });

    return ok({ success: true, status: 'confirmada' });
  } catch (e) {
    console.error('[reception-corregir-checkin]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
