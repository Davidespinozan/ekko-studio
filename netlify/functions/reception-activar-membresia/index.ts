import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { writeAuditLog } from '../_lib/auditLog';
import { esStaffActivo, puedeOperarSobre } from '../_lib/staff';

/**
 * POST /reception-activar-membresia
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, tier: <slug>, operation_id: <uuid>, metodo, referencia?, nota?, confirmar_perdida? }
 *
 * PKG-01D · Venta de MOSTRADOR con evidencia financiera durable. Ya no llama a
 * `activar_membresia` a secas: pasa por `registrar_venta_mostrador`, la
 * primitiva server-owned que en UNA transacción valida actor/tenant/target/
 * plan, deriva el precio del catálogo (D9: cortesía cobra 0), guarda la
 * evidencia con snapshot en `ventas_mostrador`, activa por el RPC de R1 con la
 * referencia `mostrador:<operation_id>` y devuelve un resultado estructurado.
 *
 *   operation_id  UUID generado UNA vez por intención en la UI; un reintento
 *                 (doble clic, timeout, refresh) devuelve la MISMA venta
 *                 (idempotente=true) en vez de activar dos veces.
 *   metodo        efectivo | transferencia | terminal | cortesia (enum cerrado).
 *   D-01D-5       sin operation_id o sin metodo → 400. No hay camino legacy.
 *   D-01D-3       suscripción de Stripe viva → 409 suscripcion_stripe (no se cancela aquí).
 *
 * `confirmar_perdida`: pasar a un plan SIN créditos quema el saldo del paquete
 * que tenía el miembro. Sin `true` explícito el RPC rechaza
 * (EKKO_PERDERIA_CREDITOS) y aquí se responde 409 con el saldo en juego.
 *
 * El cliente NO determina monto, precio, moneda, actor ni tenant. La nota no es
 * evidencia. Gobernanza (Bloque A): rol admin/recepcionista, mismo tenant (H3),
 * audit_log (best-effort, complementario a la evidencia).
 */

const METODOS = new Set(['efectivo', 'transferencia', 'terminal', 'cortesia']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  usuario_id?: string;
  tier?: string;
  operation_id?: unknown;
  metodo?: unknown;
  referencia?: unknown;
  nota?: unknown;
  /** Alias histórico de `nota`. */
  motivo?: unknown;
  confirmar_perdida?: boolean;
}

function texto(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
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
    // D-01D-5: sin identidad de operación o sin método no hay venta. Nada de defaults.
    if (typeof body.operation_id !== 'string' || !UUID_RE.test(body.operation_id)) {
      return badRequest('operation_id requerido (UUID). Actualiza la app de recepción.');
    }
    if (typeof body.metodo !== 'string' || !METODOS.has(body.metodo)) {
      return badRequest('metodo requerido: efectivo, transferencia, terminal o cortesia');
    }
    const operationId = body.operation_id.toLowerCase();
    const nota = texto(body.nota, 500) ?? texto(body.motivo, 500);
    const referencia = texto(body.referencia, 120);

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

    // Target del mismo tenant.
    const { data: target, error: targetErr } = await supabaseAdmin
      .from('usuarios')
      .select('id, tenant_id, rol, status, membresia_tier')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError(targetErr.message);
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) {
      return forbidden('El miembro pertenece a otro estudio');
    }
    if (!puedeOperarSobre(caller, target)) {
      return forbidden('Solo un admin puede modificar las cuentas del equipo');
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

    // Venta + activación en UNA transacción (registrar_venta_mostrador → activar_membresia).
    const { data: result, error: rpcErr } = await supabaseAdmin.rpc('registrar_venta_mostrador', {
      p_operation_id: operationId,
      p_actor_id: caller.id,
      p_usuario_id: target.id,
      p_tier_id: tier.id,
      p_metodo: body.metodo,
      p_referencia: referencia ?? null,
      p_nota: nota ?? null,
      p_confirmar_perdida: body.confirmar_perdida === true
    });
    if (rpcErr) {
      const m = rpcErr.message;
      if (m.includes('EKKO_PERDERIA_CREDITOS')) {
        const creditos = Number.parseInt(m.match(/perdería (\d+)/)?.[1] ?? '', 10);
        return conflicto(
          `El miembro perdería ${Number.isFinite(creditos) ? creditos : 'sus'} crédito(s) al cambiar a este plan. Confirma para continuar.`,
          'perderia_creditos',
          { creditos: Number.isFinite(creditos) ? creditos : null }
        );
      }
      if (m.includes('EKKO_TIENE_SUSCRIPCION_STRIPE')) {
        return conflicto('El miembro tiene una suscripción de Stripe vigente. Cancélala primero desde su membresía; la venta de mostrador no la sustituye.', 'suscripcion_stripe');
      }
      if (m.includes('EKKO_OPERACION_MOSTRADOR_CONFLICTO')) {
        return conflicto('Esta operación ya se registró con otros datos. Cierra y vuelve a abrir la venta.', 'operacion_conflicto');
      }
      if (m.includes('EKKO_ACTOR_NO_AUTORIZADO') || m.includes('EKKO_TENANT_DISTINTO')) return forbidden('No puedes registrar esta venta');
      if (m.includes('EKKO_TIER_INVALIDO')) return badRequest('Plan no encontrado o inactivo');
      if (m.includes('EKKO_METODO_INVALIDO')) return badRequest('Método de pago no reconocido');
      console.error('[reception-activar-membresia] rpc', m);
      return serverError('No se pudo registrar la venta. Intenta de nuevo con la misma operación.');
    }
    const venta = (result ?? {}) as {
      success?: boolean;
      idempotente?: boolean;
      venta_id?: string;
      membresia_id?: string;
      metodo?: string;
      precio_lista_centavos?: number;
      monto_cobrado_centavos?: number;
      moneda?: string;
      activacion?: unknown;
    };

    // Estado REAL tras la activación (F2 · R1): una sanción deja 'suspendido' y una
    // revocación 'revocado'; el audit no debe afirmar 'activo'.
    const fin = await supabaseAdmin.from('usuarios').select('status, membresia_tier').eq('id', target.id).maybeSingle();
    const final = (fin?.data as { status?: string; membresia_tier?: string | null } | null) ?? null;

    // Un replay no vuelve a auditar: la evidencia ya existe y no hubo efecto nuevo.
    if (!venta.idempotente) {
      await writeAuditLog(supabaseAdmin, {
        tenant_id: target.tenant_id,
        actor_usuario_id: caller.id,
        actor_rol: caller.rol,
        accion: 'membership_activated',
        target_tipo: 'usuario',
        target_id: target.id,
        antes: { status: target.status, membresia_tier: target.membresia_tier },
        despues: { status: final?.status ?? 'activo', membresia_tier: final?.membresia_tier ?? tier.slug },
        motivo: nota,
        metadata: {
          via: 'mostrador',
          venta_id: venta.venta_id ?? null,
          operation_id: operationId,
          metodo: venta.metodo ?? body.metodo,
          monto_cobrado_centavos: venta.monto_cobrado_centavos ?? null,
          precio_lista_centavos: venta.precio_lista_centavos ?? null,
          perdida_de_creditos_confirmada: body.confirmar_perdida === true
        }
      });
    }

    return ok({
      success: true,
      idempotente: venta.idempotente === true,
      venta: {
        id: venta.venta_id ?? null,
        membresia_id: venta.membresia_id ?? null,
        metodo: venta.metodo ?? body.metodo,
        precio_lista_centavos: venta.precio_lista_centavos ?? null,
        monto_cobrado_centavos: venta.monto_cobrado_centavos ?? null,
        moneda: venta.moneda ?? null
      },
      result: venta.activacion ?? result
    });
  } catch (e) {
    console.error('[reception-activar-membresia]', e instanceof Error ? e.message : e);
    return serverError('No se pudo registrar la venta. Intenta de nuevo con la misma operación.');
  }
};

function conflicto(mensaje: string, code: string, extra: Record<string, unknown> = {}) {
  return {
    statusCode: 409,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: mensaje, code, ...extra })
  };
}
