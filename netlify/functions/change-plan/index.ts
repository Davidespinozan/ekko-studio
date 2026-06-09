import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * POST /change-plan
 * Auth: Bearer JWT del miembro (cambia SU PROPIA membresía, nunca la de otro).
 * Body: { tier: <slug de un tier activo del tenant> }
 *
 * Cambio de plan self-serve, en-app. El trigger SEC-FIX C2
 * (`proteger_columnas_privilegiadas_usuarios`) bloquea que el cliente toque
 * `membresia_tier` directamente; por eso el cambio pasa por esta función con
 * service_role.
 *
 * IMPORTANTE — monetización: en la fase actual los pagos son SIMULADOS (no hay
 * Stripe). Esta función cambia el `membresia_tier` pero **NO toca `status`**:
 * no activa cuentas inertes (pendiente_pago sigue sin poder reservar). Cuando
 * se integre Stripe, el cambio de plan debe gatearse detrás del cobro real
 * (Checkout/Customer Portal + webhook) en lugar de aplicarse aquí sin pago.
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const { tier } = JSON.parse(event.body || '{}') as { tier?: string };
    if (!tier || typeof tier !== 'string') return badRequest('tier requerido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    // 1. Resolver al miembro a partir de SU token (no se acepta usuario_id del body).
    const supabaseAsUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await supabaseAsUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: perfil, error: perfilErr } = await supabaseAsUser
      .from('usuarios')
      .select('id, tenant_id, membresia_tier')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (perfilErr || !perfil) return unauthorized('No encontramos tu cuenta');

    if (perfil.membresia_tier === tier) {
      return ok({ success: true, tier, sin_cambios: true });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    // 2. Validar que el tier exista y esté activo en el tenant del miembro.
    const { data: tierData, error: tierErr } = await supabaseAdmin
      .from('tiers')
      .select('slug')
      .eq('tenant_id', perfil.tenant_id)
      .eq('slug', tier)
      .eq('activo', true)
      .maybeSingle();
    if (tierErr || !tierData) return badRequest(`Plan "${tier}" no encontrado o inactivo`);

    // 3. Aplicar el cambio de tier (service_role pasa el trigger C2).
    //    NO se toca `status`: no activa cuentas ni finge un pago.
    const { error: updateErr } = await supabaseAdmin
      .from('usuarios')
      .update({ membresia_tier: tier })
      .eq('id', perfil.id);
    if (updateErr) return serverError(updateErr.message);

    return ok({ success: true, tier });
  } catch (e) {
    console.error('[change-plan]', e);
    return serverError(e instanceof Error ? e.message : 'Error inesperado');
  }
};
