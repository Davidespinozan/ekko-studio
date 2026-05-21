import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

/**
 * POST /fake-signup
 * Body: { nombre, email, password, tier: 'basica' | 'pro' }
 *
 * Alta pública de un miembro PENDIENTE DE PAGO (Stripe aún no integrado):
 * - auth.admin.createUser (email confirmado automáticamente)
 * - El trigger on_auth_user_created inserta fila en `usuarios`
 * - UPDATE para setear nombre/tier/tenant y status='pendiente_pago'
 *
 * SEC-FIX (C1): este endpoint es público y sin auth. Antes creaba cuentas
 * `status='activo'` + un payment_event 'fake_succeeded' → cualquiera con
 * `curl` se daba de alta una cuenta activa gratis (bypass de monetización).
 * Ahora la cuenta nace `pendiente_pago`: NO puede reservar (el RPC valida
 * status='activo') hasta que admin/Stripe la active. Ya no se finge un
 * pago: sin `payment_events`. Cuando se integre Stripe real, el webhook
 * reemplaza esta función y es quien activa la cuenta al cobrar.
 */

const TIERS_VALIDOS = ['basica', 'pro'] as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[fake-signup] Missing env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const { nombre, email, password, tier } = JSON.parse(event.body || '{}');

    if (!nombre || !email || !password || !tier) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Faltan datos requeridos' })
      };
    }

    if (!TIERS_VALIDOS.includes(tier)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Tier inválido' })
      };
    }

    // 1. Obtener tenant 'ekko'
    const { data: tenant, error: tenantError } = await supabaseAdmin
      .from('tenants')
      .select('id')
      .eq('slug', 'ekko')
      .single();

    if (tenantError || !tenant) {
      console.error('[fake-signup] tenant error:', tenantError);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Error de configuración' })
      };
    }

    // 1b. Validar que el tier exista y esté activo en el tenant.
    const { data: tierData, error: tierError } = await supabaseAdmin
      .from('tiers')
      .select('slug')
      .eq('tenant_id', tenant.id)
      .eq('slug', tier)
      .eq('activo', true)
      .single();

    if (tierError || !tierData) {
      console.error('[fake-signup] tier error:', tierError);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Plan "${tier}" no encontrado o inactivo.` })
      };
    }

    // 2. Crear usuario en auth.users — esto dispara el trigger
    //    on_auth_user_created que inserta fila en `usuarios` con
    //    rol='miembro', status='pendiente_onboarding'.
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nombre, tenant_slug: 'ekko' }
    });

    if (authError || !authData.user) {
      console.error('[fake-signup] auth error:', authError);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: authError?.message || 'Error al crear usuario' })
      };
    }

    const authUserId = authData.user.id;

    // 3. Actualizar la fila que creó el trigger con nombre/tier/tenant.
    //    status='pendiente_pago' (SEC-FIX C1): la cuenta nace inerte — no
    //    puede reservar hasta que admin/Stripe la active. NO se finge un pago.
    //    NOTA: la columna FK a auth.users se llama `auth_id` (no auth_user_id).
    const fechaHoy = new Date().toLocaleDateString('es-MX');
    const { data: usuarioUpdated, error: updateError } = await supabaseAdmin
      .from('usuarios')
      .update({
        nombre,
        membresia_tier: tier,
        status: 'pendiente_pago',
        rol: 'miembro',
        tenant_id: tenant.id,
        notas_admin: `Alta por signup público — pendiente de pago (${fechaHoy})`
      })
      .eq('auth_id', authUserId)
      .select('id')
      .single();

    if (updateError || !usuarioUpdated) {
      console.error('[fake-signup] update error:', updateError);
      // Best-effort cleanup: borrar auth.user para no dejar zombies
      await supabaseAdmin.auth.admin.deleteUser(authUserId);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Error al registrar la cuenta' })
      };
    }

    // SEC-FIX (C1): NO se inserta payment_event — no hubo pago. El webhook
    // real de Stripe será el único que escriba en `payment_events`.

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        auth_user_id: authUserId
      })
    };
  } catch (err) {
    console.error('[fake-signup] unexpected error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err instanceof Error ? err.message : 'Error inesperado'
      })
    };
  }
};
