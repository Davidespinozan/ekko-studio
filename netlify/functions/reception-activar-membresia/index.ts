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
 * POST /reception-activar-membresia
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, tier: <slug> }
 *
 * Activación en MOSTRADOR (D4: self-serve + recepción). Recepción confirma el
 * pago en persona y activa la membresía del miembro vía el RPC keystone
 * `activar_membresia` — el MISMO punto de activación que usará el webhook de
 * Stripe. Crea la fila en `membresias`, pone status='activo' + tier.
 *
 * Cierra B3: activar pasa por un solo lugar, así que la cuenta queda consistente
 * (no más "cambié el tier pero sigue inerte").
 *
 * Gobernanza (Bloque A): rol admin/recepcionista, mismo tenant (H3), audit_log.
 */

interface Body {
  usuario_id?: string;
  tier?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');
    if (!body.tier) return badRequest('tier requerido');

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

    // Target del mismo tenant.
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id, status, membresia_tier')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) {
      return forbidden('El miembro pertenece a otro estudio');
    }

    // Resolver el tier (slug → id) en el tenant.
    const { data: tier, error: tierErr } = await supabaseAdmin
      .from('tiers')
      .select('id, slug')
      .eq('tenant_id', target.tenant_id)
      .eq('slug', body.tier)
      .eq('activo', true)
      .maybeSingle();
    if (tierErr) return serverError(tierErr.message);
    if (!tier) return badRequest(`Plan "${body.tier}" no encontrado o inactivo`);

    // Activar vía el RPC keystone (sin IDs de Stripe — pago en mostrador).
    const { data: result, error: rpcErr } = await supabaseAdmin.rpc('activar_membresia', {
      p_usuario_id: target.id,
      p_tier_id: tier.id
    });
    if (rpcErr) return serverError(rpcErr.message);

    await writeAuditLog(supabaseAdmin, {
      tenant_id: target.tenant_id,
      actor_usuario_id: caller.id,
      actor_rol: caller.rol,
      accion: 'membership_activated',
      target_tipo: 'usuario',
      target_id: target.id,
      antes: { status: target.status, membresia_tier: target.membresia_tier },
      despues: { status: 'activo', membresia_tier: tier.slug },
      metadata: { via: 'mostrador' }
    });

    return ok({ success: true, result });
  } catch (e) {
    console.error('[reception-activar-membresia]', e);
    return serverError(e instanceof Error ? e.message : 'Error desconocido');
  }
};
