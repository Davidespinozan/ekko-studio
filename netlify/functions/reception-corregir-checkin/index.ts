import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { badRequest, unauthorized, forbidden } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv } from '../_lib/env';
import { esStaffActivo } from '../_lib/staff';
import { corregirAsistencia } from '../_lib/corregirAsistencia';

/**
 * POST /reception-corregir-checkin
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { reserva_id, motivo }   // motivo OBLIGATORIO
 *
 * Deshace un check-in mal hecho (miembro equivocado, marcado sin presentarse):
 * completada → confirmada y se limpian check_in_at / check_in_by /
 * check_in_method. Limitado al MISMO DÍA (zona America/Mazatlan).
 *
 * R2-A (PKG-01I): la transición la hace la RPC `staff_corregir_asistencia`
 * (reserva bloqueada, solo desde `completada`, audit_log 'checkin_correction'
 * en la misma transacción). Mismo tenant, rol staff activo, motivo obligatorio.
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
      accion: 'deshacer_checkin',
      motivo
    });
  } catch (e) {
    console.error('[reception-corregir-checkin]', e);
    return errorInterno('reception-corregir-checkin', e);
  }
};
