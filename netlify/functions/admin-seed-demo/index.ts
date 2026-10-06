import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { ok, unauthorized, forbidden, serverError, badRequest } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv } from '../_lib/env';
import { esAdminActivo } from '../_lib/staff';

/**
 * POST /admin-seed-demo — crea/regenera las CUENTAS DEMO (una por rol) para que
 * el dueño pruebe cada rol de verdad (auth + datos reales), en vez de un preview.
 * Auth: Bearer JWT del admin. Idempotente: si ya existen, resetea su password.
 *
 * - demo-miembro@…   → miembro ACTIVO con plan (esencial) + ficha lista (para
 *                       probar reservas y check-in sin el gate).
 * - demo-recepcion@… → recepcionista activo.
 * - demo-staff@…     → staff activo.
 * Todas con la MISMA password, generada AL AZAR en cada corrida y devuelta una
 * sola vez para mostrarla. Nunca una constante: esta function crea un ADMIN real
 * en el tenant de producción, y una clave fija en el repo era una puerta abierta
 * para cualquiera que leyera el código (volver a correrla rota la clave).
 */

// Sin caracteres ambiguos (0/O, 1/l/I): se dicta y se teclea.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function generarPasswordDemo(len = 14): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALFABETO[randomInt(ALFABETO.length)];
  return out;
}

interface DemoDef {
  email: string;
  nombre: string;
  rol: 'miembro' | 'recepcionista' | 'admin';
}

// Roles reales: admin, recepcionista y miembro. No hay 'staff'.
const DEMOS: DemoDef[] = [
  { email: 'demo-miembro@ekkostudio.app', nombre: 'Demo Miembro', rol: 'miembro' },
  { email: 'demo-recepcion@ekkostudio.app', nombre: 'Demo Recepción', rol: 'recepcionista' },
  { email: 'demo-admin@ekkostudio.app', nombre: 'Demo Admin', rol: 'admin' }
];

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const demoPassword = generarPasswordDemo();

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: admin } = await asUser
      .from('usuarios')
      .select('tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!admin?.tenant_id || !esAdminActivo(admin)) {
      return forbidden('Solo el admin puede crear cuentas demo');
    }
    const tenantId = admin.tenant_id;

    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Limpieza: el rol 'staff' ya no existe. Si una corrida previa dejó un
    // demo-staff a medias, se elimina (best-effort).
    try {
      const { data: staffViejo } = await db
        .from('usuarios')
        .select('auth_id')
        .eq('email', 'demo-staff@ekkostudio.app')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (staffViejo?.auth_id) {
        await db.from('usuarios').delete().eq('auth_id', staffViejo.auth_id);
        await db.auth.admin.deleteUser(staffViejo.auth_id);
      }
    } catch (e) {
      console.error('[admin-seed-demo] limpieza staff', e instanceof Error ? e.message : e);
    }

    // Tier para el miembro demo (esencial; si no, cualquier plan activo).
    const { data: tierEsencial } = await db
      .from('tiers')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('activo', true)
      .eq('slug', 'esencial')
      .maybeSingle();
    let tierId = tierEsencial?.id ?? null;
    if (!tierId) {
      const { data: anyTier } = await db
        .from('tiers').select('id').eq('tenant_id', tenantId).eq('activo', true)
        .order('orden', { ascending: true }).limit(1).maybeSingle();
      tierId = anyTier?.id ?? null;
    }

    for (const demo of DEMOS) {
      // ¿ya existe la cuenta? (por email en el mismo tenant)
      const { data: existente } = await db
        .from('usuarios')
        .select('id, auth_id')
        .eq('email', demo.email)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      let authId: string;
      if (existente?.auth_id) {
        // Resetear password (idempotente).
        await db.auth.admin.updateUserById(existente.auth_id, {
          password: demoPassword,
          email_confirm: true
        });
        authId = existente.auth_id;
      } else {
        const { data: creado, error: crearErr } = await db.auth.admin.createUser({
          email: demo.email,
          password: demoPassword,
          email_confirm: true,
          user_metadata: { tenant_slug: 'ekko', nombre: demo.nombre }
        });
        if (crearErr || !creado?.user) {
          return serverError(`No se pudo crear ${demo.email}: ${crearErr?.message ?? 'desconocido'}`);
        }
        authId = creado.user.id;
      }

      // Rol + status + nombre (el trigger dejó rol='miembro' por defecto).
      const patch: Record<string, unknown> = {
        rol: demo.rol,
        status: 'activo',
        nombre: demo.nombre,
        tenant_id: tenantId
      };
      // Miembro demo: ficha lista para poder probar el check-in sin el gate.
      if (demo.rol === 'miembro') {
        patch.identidad_completa = true;
        patch.contrato_firmado = true;
      }
      await db.from('usuarios').update(patch).eq('auth_id', authId);

      // Miembro demo: activar plan para poder reservar.
      if (demo.rol === 'miembro' && tierId) {
        const { data: uRow } = await db.from('usuarios').select('id').eq('auth_id', authId).maybeSingle();
        if (uRow?.id) {
          await db.rpc('activar_membresia', {
            p_usuario_id: uRow.id,
            p_tier_id: tierId,
            p_stripe_subscription_id: null,
            p_stripe_customer_id: null,
            p_periodo_fin: null
          });
        }
      }
    }

    return ok({
      success: true,
      password: demoPassword,
      cuentas: DEMOS.map((d) => ({ email: d.email, rol: d.rol, nombre: d.nombre }))
    });
  } catch (e) {
    console.error('[admin-seed-demo]', e instanceof Error ? e.message : e);
    return errorInterno('admin-seed-demo', e);
  }
};
