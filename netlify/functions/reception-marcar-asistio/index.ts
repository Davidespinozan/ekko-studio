import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { esStaffActivo } from '../_lib/staff';
import { corregirAsistencia } from '../_lib/corregirAsistencia';

/**
 * POST /reception-marcar-asistio
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { reserva_id, motivo }   // motivo OBLIGATORIO
 *
 * Corrige la asistencia: el miembro SÍ vino pero nadie le hizo el check-in y el
 * cron lo marcó `no_show`. (Portado de SALA 5580fdb.)
 *
 * R2-A (PKG-01I): toda la corrección la hace la RPC `staff_corregir_asistencia`
 * en UNA transacción, con la reserva y el miembro bloqueados:
 *  - Única transición: no_show → completada (check-in manual de ahora), con
 *    la sesión ya iniciada. Una reserva CANCELADA ya no se revive (antes daba
 *    una sesión gratis: su crédito ya se había devuelto); se crea una nueva.
 *  - Revierte la falta (no_shows_count − 1) y levanta el bloqueo vigente si el
 *    contador cae bajo el umbral del estudio.
 *  - Créditos: no se tocan (el no_show ya consumió el suyo).
 *  - Aplican la guarda de identidad y el bloqueo de cuenta revocada (R1).
 *  - audit_log 'asistencia_correction' con motivo, en la misma transacción.
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

    return await corregirAsistencia(supabaseAdmin, {
      actorId: caller.id,
      reservaId: body.reserva_id,
      accion: 'asistio',
      motivo
    });
  } catch (e) {
    console.error('[reception-marcar-asistio]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
