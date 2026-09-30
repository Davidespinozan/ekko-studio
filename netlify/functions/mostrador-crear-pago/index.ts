import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError, notFound } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { esStaffActivo, puedeOperarSobre } from '../_lib/staff';
import { resolverCuentaConectada, getOrCreateSocioCustomer } from '../_lib/connectBilling';
import { crearPresupuesto, leerOperationId, clasificarErrorSaliente } from '../_lib/operacionPago';
import { prepararPagoPlan, esPaquete } from '../_lib/pagoPlan';
import { saldoCreditosVivo, consentimientoPerdida } from '../_lib/perdidaCreditos';

/**
 * POST /mostrador-crear-pago
 * Auth: Bearer JWT de admin o recepcionista.
 * Body: { usuario_id, tier: <slug>, operation_id: <uuid> }
 *
 * PKG-01E · "Tarjeta por Stripe" en mostrador. El STAFF inicia el cobro de un
 * plan para un MIEMBRO objetivo; el miembro introduce su tarjeta en Stripe
 * Elements en el dispositivo de recepción. Financieramente es un pago Stripe:
 * su evidencia es `payment_events` (01A) y su activación la hace el webhook
 * (Stripe → 01A → activar_membresia). Aquí NO se activa nada ni se toca
 * `ventas_mostrador` (esa tabla es solo para efectivo/transferencia/terminal
 * externa/cortesía, D-01E-1).
 *
 * Identidad de la operación: (cuenta, miembro objetivo, operation_id). La key
 * de Stripe es `ekko:v1:<kind>:<acct>:<miembro>:<operation_id>` (01C): el mismo
 * UUID usado para otro miembro es otra identidad y nunca adopta su objeto.
 *
 * Servidor: valida staff activo, tenant, autorización sobre el miembro, plan
 * activo y en venta, UUID, guard de suscripción Stripe viva (D-01E-4: eso es
 * 01F, se rechaza) y deriva el importe del catálogo. El cliente no manda montos.
 * Sin `operation_id` no hay camino legacy: 400.
 */

interface Body {
  usuario_id?: string;
  tier?: string;
  operation_id?: unknown;
  /** PKG-01F (D-01F-6): consentimiento explícito (staff, con el miembro) para perder los créditos vivos al pasar a mensual. */
  confirmar_perdida_creditos?: unknown;
}

const FUNCION = 'mostrador-crear-pago';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');
  const presupuesto = crearPresupuesto();

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.usuario_id) return badRequest('usuario_id requerido');
    if (!body.tier) return badRequest('tier requerido');
    const operacion = leerOperationId(body.operation_id);
    if (operacion.tipo !== 'ok') return badRequest('operation_id requerido (UUID). Actualiza la app de recepción.');
    const operationId = operacion.id;

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: caller } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!esStaffActivo(caller)) return forbidden('Solo recepción o admin pueden cobrar en mostrador');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: target, error: targetErr } = await admin
      .from('usuarios')
      .select('id, tenant_id, rol, status, email, sancionado_at')
      .eq('id', body.usuario_id)
      .maybeSingle();
    if (targetErr) return serverError('No pudimos leer al miembro');
    if (!target) return notFound('Miembro no encontrado');
    if (target.tenant_id !== caller.tenant_id) return forbidden('El miembro pertenece a otro estudio');
    if (!puedeOperarSobre(caller, target)) return forbidden('Solo un admin puede modificar las cuentas del equipo');
    // Misma regla que el pago self-serve: una sanción no se compra.
    if (target.sancionado_at || target.status === 'revocado') {
      return forbidden('La cuenta del miembro está suspendida por el estudio; resuélvelo antes de cobrar un plan.');
    }

    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, activo, en_venta, tenant_id, nombre, precio_centavos, moneda, tipo')
      .eq('tenant_id', target.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.activo !== true) return badRequest('Plan no encontrado o inactivo');
    if (tier.en_venta === false) return badRequest('Este plan ya no está a la venta');
    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) return badRequest('Este plan no tiene un precio válido');
    if (!esPaquete(tier) && tier.tipo !== 'tiempo') return badRequest('Tipo de plan no admitido en mostrador');

    // D-01E-4: una suscripción de Stripe viva no se sustituye ni se duplica desde
    // mostrador (cambiar de plan es 01F). Se comprueba ANTES de crear nada.
    const { data: subViva } = await admin
      .from('membresias')
      .select('stripe_subscription_id')
      .eq('usuario_id', target.id)
      .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
      .not('stripe_subscription_id', 'is', null)
      .limit(1)
      .maybeSingle();
    if (subViva?.stripe_subscription_id) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'El miembro tiene una suscripción de Stripe vigente. Cancélala primero desde su membresía; el mostrador no la sustituye.',
          code: 'suscripcion_stripe'
        })
      };
    }

    // PKG-01F (D-01F-6): mensual sobre un saldo de créditos exige consentimiento explícito.
    const perdidaConfirmada = consentimientoPerdida(body.confirmar_perdida_creditos);
    if (!esPaquete(tier)) {
      const saldo = await saldoCreditosVivo(admin, target.id);
      if (saldo > 0 && !perdidaConfirmada) return ok({ estado: 'perderia_creditos', creditos: saldo, operationId });
    }

    if (!process.env.STRIPE_SECRET_KEY) return ok({ reason: 'stripe_pendiente' });
    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, target.tenant_id);
    if (!accountId || !chargesEnabled) return ok({ reason: 'cobros_no_activos' });

    const stripe = getStripe();
    const feePct = Number(optionalEnv('EKKO_FEE_PERCENT', '0')) || 0;

    // El customer es del MIEMBRO objetivo (su tarjeta, su suscripción), nunca del staff.
    let customerId: string;
    try {
      customerId = await getOrCreateSocioCustomer(
        stripe,
        admin,
        { id: target.id, tenant_id: target.tenant_id, email: target.email ?? null },
        accountId,
        { presupuesto }
      );
    } catch (e) {
      const estado = clasificarErrorSaliente(e, 'mutacion');
      return ok({ estado: estado === 'conflicto' ? 'resultado_desconocido' : estado, operationId });
    }

    const respuesta = await prepararPagoPlan({
      stripe,
      presupuesto,
      accountId,
      customerId,
      miembroId: target.id,
      tier,
      feePct,
      operationId,
      // Atribución sin PII: ids técnicos y rol.
      metadataExtra: {
        origen: 'mostrador', actor_usuario_id: caller.id, actor_rol: caller.rol ?? '',
        ...(!esPaquete(tier) && perdidaConfirmada ? { confirmar_perdida_creditos: 'true' } : {})
      },
      funcion: FUNCION
    });
    return ok({ ...respuesta, miembro: { id: target.id } });
  } catch (err) {
    console.error('[mostrador-crear-pago]', err instanceof Error ? err.message : err);
    return serverError('No pudimos preparar el cobro. Intenta de nuevo con la misma operación.');
  }
};
