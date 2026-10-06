import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe, llavePrecio } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';
import { crearPresupuesto, leerOperationId, clasificarErrorSaliente, registrarOperacion } from '../_lib/operacionPago';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /cambiar-plan-suscripcion
 * Auth: Bearer JWT del miembro. Body: { tier: <slug>, operation_id: <uuid> }
 *
 * PKG-01F · ÚNICO camino mensual → mensual. Re-precia la suscripción vigente
 * del miembro en Stripe (tarjeta guardada) y después aplica la transición de
 * tier en EKKO con `cambiar_tier_membresia` (atómica, idempotente, con
 * evidencia en audit_log). Nunca crea una segunda membresía ni llama a R1.
 *
 * Política financiera (owner):
 *   · UPGRADE (precio destino > actual): `always_invoice` + `error_if_incomplete`.
 *     Stripe cobra la prorrata AHORA con la tarjeta guardada; si no puede, el
 *     update completo falla y EKKO NO cambia el tier (D-01F-1/3).
 *   · DOWNGRADE o lateral: `create_prorations`, inmediato; el crédito lo maneja
 *     Stripe en la siguiente factura (D-01F-2).
 *
 * Guards antes de tocar Stripe: rol miembro, cuenta no sancionada/revocada,
 * tier destino activo/en venta/tipo tiempo, membresía activa con suscripción,
 * suscripción REAL leída de Stripe (customer del miembro, metadata, status
 * `active`, sin cancel_at_period_end: D-01F-7), y reservas futuras compatibles
 * con el destino (D-01F-4: se rechaza con la lista; no se cancela nada).
 *
 * Identidad: (cuenta, usuario, operation_id) → key
 * `ekko:v1:swap_mensual:<acct>:<usuario>:<operation_id>`. Recuperación: si la
 * sub ya lleva `swap_operation_id = operation_id` y el precio destino, no se
 * vuelve a mutar Stripe; solo se converge EKKO. Un swap con cobro fallido no
 * deja objeto: el cliente debe iniciar otra operación (la key replayaría el
 * mismo rechazo).
 *
 * Los resultados de negocio van con HTTP 200 y `success:false` + `code` para que
 * la UI los distinga (backend.ts solo conserva el mensaje en los 4xx).
 *
 * PKG-06B (FR-15): la intención queda DURABLE en `stripe_operaciones_suscripcion`
 * (tipo `cambiar_plan`, identidad = operation_id) después de los guardias y antes
 * de mutar Stripe, y se cierra con honestidad: `aplicada` solo si Stripe aplicó Y
 * EKKO convergió; `descartada` si Stripe definitivamente no mutó; `fallida` si el
 * resultado es desconocido, el cobro no se confirmó o EKKO no convergió — visible
 * en Operación aunque el miembro no vuelva a intentarlo.
 */

interface Body {
  tier?: string;
  operation_id?: unknown;
}

const FUNCION = 'cambiar-plan-suscripcion';

const rechazo = (code: string, mensaje: string, extra: Record<string, unknown> = {}) => ok({ success: false, code, error: mensaje, ...extra });

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');
  const presupuesto = crearPresupuesto();

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.tier) return badRequest('tier requerido');
    const operacion = leerOperationId(body.operation_id);
    if (operacion.tipo !== 'ok') return badRequest('operation_id requerido (UUID). Actualiza la app.');
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

    const { data: socio } = await asUser
      .from('usuarios')
      .select('id, tenant_id, rol, status, sancionado_at')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede cambiar su plan');
    // R1 manda: una cuenta sancionada o revocada no cambia de plan.
    if (socio.sancionado_at || socio.status === 'revocado') {
      return forbidden('Tu cuenta está suspendida por el estudio. Escríbenos para resolverlo antes de cambiar de plan.');
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, activo, en_venta, tenant_id, nombre, precio_centavos, moneda, tipo')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) return badRequest('Plan inválido');
    if (tier.en_venta === false) return badRequest('Este plan ya no está a la venta');
    // El swap solo tiene sentido entre planes mensuales; los paquetes se compran.
    if (tier.tipo !== 'tiempo') return ok({ reason: 'sin_suscripcion' });
    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) return badRequest('Este plan no tiene un precio válido');

    // Membresía viva con suscripción. D-01F-7: solo `activa` se re-precia.
    const { data: mem } = await admin
      .from('membresias')
      .select('id, tier_id, status, stripe_subscription_id, stripe_customer_id')
      .eq('usuario_id', socio.id)
      .not('stripe_subscription_id', 'is', null)
      .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mem?.stripe_subscription_id) return ok({ reason: 'sin_suscripcion' });
    if (mem.tier_id === tier.id) return badRequest('Ya tienes este plan');
    if (mem.status !== 'activa') {
      return rechazo(mem.status === 'past_due' ? 'morosidad' : 'estado_no_permitido', mensajeEstado(mem.status));
    }

    if (!process.env.STRIPE_SECRET_KEY) return ok({ reason: 'stripe_pendiente' });
    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) return ok({ reason: 'cobros_no_activos' });

    // Customer del miembro (fuente: datos privados; respaldo: la membresía).
    const { data: dp } = await admin.from('usuarios_datos_privados').select('stripe_customer_id').eq('usuario_id', socio.id).maybeSingle();
    const customerDelSocio: string | null = dp?.stripe_customer_id ?? mem.stripe_customer_id ?? null;

    const stripe = getStripe();
    const opt = { stripeAccount: accountId };

    // ── Estado REAL de la suscripción en Stripe ─────────────────────────────
    let sub: Stripe.Subscription;
    try {
      sub = await stripe.subscriptions.retrieve(mem.stripe_subscription_id, { expand: ['latest_invoice'] }, { ...opt, ...presupuesto.opcionesLectura() });
    } catch (e) {
      const clase = clasificarErrorSaliente(e, 'lectura');
      if (clase === 'pago_no_iniciable') return rechazo('sub_no_verificada', 'No encontramos tu suscripción en Stripe. Acércate a recepción.');
      return rechazo('reintentable', 'No pudimos leer tu suscripción. Intenta de nuevo.');
    }
    const subCustomer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (customerDelSocio && subCustomer !== customerDelSocio) return rechazo('sub_no_verificada', 'La suscripción no corresponde a tu cuenta. Acércate a recepción.');
    if (!customerDelSocio) return rechazo('sub_no_verificada', 'No pudimos verificar tu suscripción. Acércate a recepción.');
    if (sub.metadata?.usuario_id && sub.metadata.usuario_id !== socio.id) return rechazo('sub_no_verificada', 'La suscripción no corresponde a tu cuenta. Acércate a recepción.');
    if (sub.status !== 'active') return rechazo(sub.status === 'past_due' || sub.status === 'unpaid' ? 'morosidad' : 'estado_no_permitido', mensajeEstado(sub.status));
    if (sub.cancel_at_period_end) return rechazo('cancelacion_programada', 'Tu suscripción tiene una cancelación programada. Reactívala antes de cambiar de plan.');
    const item = sub.items?.data?.[0];
    if (!item || sub.items.data.length !== 1) return rechazo('sub_no_verificada', 'Tu suscripción no tiene la forma esperada. Acércate a recepción.');

    // ── Binding de la operación con la suscripción ──────────────────────────
    const swapOp = sub.metadata?.swap_operation_id ?? null;
    const swapTier = sub.metadata?.swap_tier_id ?? null;
    if (swapOp === operationId && swapTier && swapTier !== tier.id) {
      return rechazo('operacion_conflicto', 'Esta operación ya corresponde a otro cambio de plan. Vuelve a abrir el cambio.');
    }
    const currency = (tier.moneda || 'mxn').toLowerCase();
    const precioActual = item.price?.unit_amount ?? null;
    const yaEnDestino = swapOp === operationId && swapTier === tier.id && precioActual === tier.precio_centavos && (item.price?.currency ?? '').toLowerCase() === currency;

    // ── D-01F-4: reservas futuras incompatibles con el destino → rechazo ────
    const { data: incompatibles, error: errGuard } = await admin.rpc('reservas_incompatibles_con_tier', { p_usuario_id: socio.id, p_tier_id: tier.id });
    if (errGuard) return rechazo('reintentable', 'No pudimos comprobar tus reservas. Intenta de nuevo.');
    const lista = (incompatibles ?? []) as Array<Record<string, unknown>>;
    if (lista.length > 0 && !yaEnDestino) {
      return rechazo('reservas_incompatibles', 'Tienes reservas que el plan nuevo no permite. Cámbialas o cancélalas antes de cambiar de plan.', { reservas: lista });
    }

    // Dirección económica por importe recurrente real (no por tiers.orden).
    const direccion: 'upgrade' | 'downgrade' | 'lateral' =
      precioActual === null ? 'upgrade' : tier.precio_centavos > precioActual ? 'upgrade' : tier.precio_centavos < precioActual ? 'downgrade' : 'lateral';

    // ── PKG-06B · Intención durable ANTES de mutar la suscripción ─────────
    const { error: errReg } = await admin.rpc('cambio_plan_registrar', {
      p_operation_id: operationId,
      p_usuario_id: socio.id,
      p_membresia_id: mem.id,
      p_tier_destino: tier.id,
      p_direccion: direccion
    });
    if (errReg) {
      if (errReg.message.includes('EKKO_OPERACION_CONFLICTO')) return rechazo('operacion_conflicto', 'Esta operación ya corresponde a otro cambio de plan. Vuelve a abrir el cambio.');
      await reportarErrorServidor(FUNCION, new Error(errReg.message), { paso: 'cambio_plan_registrar' });
      return rechazo('reintentable', 'No pudimos iniciar el cambio. Intenta de nuevo.');
    }
    const cerrar = (estado: 'aplicada' | 'descartada' | 'fallida', codigo: string, resultado: Record<string, unknown> = {}) =>
      cerrarCambioPlan(admin, operationId, estado, codigo, resultado);

    let subFinal: Stripe.Subscription = sub;
    let cobro: { invoice_id: string | null; amount_paid_centavos: number | null; moneda: string | null } | null = null;

    if (!yaEnDestino) {
      if (!presupuesto.puedeMutar()) {
        await cerrar('descartada', 'sin_efecto');
        return rechazo('reintentable', 'No pudimos completar el cambio a tiempo. Intenta de nuevo.');
      }
      // Precio recurrente destino en la cuenta conectada (idempotente por tier+precio).
      let priceId: string;
      try {
        const price = await stripe.prices.create(
          { unit_amount: tier.precio_centavos, currency, recurring: { interval: 'month' }, product_data: { name: tier.nombre } },
          { ...opt, idempotencyKey: llavePrecio({ tierId: tier.id, accountId, centavos: tier.precio_centavos, currency, nombre: tier.nombre }), ...presupuesto.opcionesMutacion() }
        );
        priceId = price.id;
      } catch (e) {
        // El precio no es la suscripción: nada del plan del miembro cambió.
        await cerrar('descartada', 'sin_efecto');
        return rechazo(transporte(clasificarErrorSaliente(e, 'mutacion')), 'No pudimos preparar el precio del plan. Intenta de nuevo.');
      }

      if (!presupuesto.puedeMutar()) {
        await cerrar('descartada', 'sin_efecto');
        return rechazo('reintentable', 'No pudimos completar el cambio a tiempo. Intenta de nuevo.');
      }
      const key = `ekko:v1:swap_mensual:${accountId}:${socio.id}:${operationId}`;
      const params: Stripe.SubscriptionUpdateParams = {
        items: [{ id: item.id, price: priceId }],
        metadata: { app: 'ekko', usuario_id: socio.id, tier_id: tier.id, swap_operation_id: operationId, swap_tier_id: tier.id },
        expand: ['latest_invoice'],
        ...(direccion === 'upgrade'
          ? { proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' }
          : { proration_behavior: 'create_prorations' })
      };
      try {
        subFinal = await stripe.subscriptions.update(mem.stripe_subscription_id, params, { ...opt, idempotencyKey: key, ...presupuesto.opcionesMutacion() });
      } catch (e) {
        const err = e as { type?: string; code?: string; message?: string; statusCode?: number };
        const clase = clasificarErrorSaliente(e, 'mutacion');
        // NO PAYMENT → NO UPGRADE: Stripe rechazó el update porque no pudo cobrar. Nada cambió.
        if (esFalloDeCobro(err)) {
          registrarOperacion({ funcion: FUNCION, kind: 'sub_mensual', usuario_id: socio.id, estado: 'cobro_fallido' });
          await cerrar('descartada', 'cobro_fallido');
          return rechazo('cobro_fallido', 'No pudimos cobrar la diferencia con tu tarjeta. Tu plan no cambió. Actualiza tu tarjeta e inicia el cambio de nuevo.');
        }
        if (clase === 'conflicto') {
          await cerrar('fallida', 'operacion_conflicto');
          return rechazo('operacion_conflicto', 'Esta operación ya se usó con otros datos. Vuelve a abrir el cambio.');
        }
        if (clase === 'resultado_desconocido') {
          // Ambiguo: NO se descarta ni se cambia de identidad; el reintento con la
          // MISMA operación converge (misma llave en Stripe).
          await cerrar('fallida', 'resultado_desconocido');
          return rechazo('resultado_desconocido', 'No pudimos confirmar el cambio. Reintenta: no se aplicará dos veces.');
        }
        if (clase === 'pago_no_iniciable') {
          await cerrar('descartada', 'pago_no_iniciable');
          return rechazo('pago_no_iniciable', 'No pudimos cambiar tu plan. Acércate a recepción.');
        }
        await cerrar('descartada', 'sin_efecto');
        return rechazo('reintentable', 'No pudimos cambiar tu plan. Intenta de nuevo.');
      }
    }

    // ── Liquidación: un upgrade exige la factura de prorrata PAGADA ─────────
    const inv = subFinal.latest_invoice && typeof subFinal.latest_invoice === 'object' ? (subFinal.latest_invoice as Stripe.Invoice) : null;
    if (direccion === 'upgrade') {
      const pagada = !!inv && inv.status === 'paid';
      if (!pagada) {
        // Con error_if_incomplete esto no debería ocurrir; si ocurre, no se afirma nada.
        registrarOperacion({ funcion: FUNCION, kind: 'sub_mensual', usuario_id: socio.id, estado: 'requiere_revision' });
        await cerrar('fallida', 'requiere_revision');
        return rechazo('requiere_revision', 'No pudimos confirmar el cobro del cambio. No lo repitas: el estudio lo revisará.');
      }
      cobro = { invoice_id: inv.id ?? null, amount_paid_centavos: inv.amount_paid ?? null, moneda: inv.currency ?? null };
    } else if (inv && inv.billing_reason === 'subscription_update') {
      cobro = { invoice_id: inv.id ?? null, amount_paid_centavos: inv.amount_paid ?? null, moneda: inv.currency ?? null };
    }

    // ── Transición de EKKO: atómica, idempotente, con evidencia ─────────────
    const precioNuevo = subFinal.items?.data?.[0]?.price?.unit_amount ?? tier.precio_centavos;
    const { data: cambio, error: errCambio } = await admin.rpc('cambiar_tier_membresia', {
      p_operation_id: operationId,
      p_usuario_id: socio.id,
      p_membresia_id: mem.id,
      p_tier_destino: tier.id,
      p_stripe_subscription_id: mem.stripe_subscription_id,
      p_resumen: {
        direccion,
        precio_anterior_centavos: precioActual,
        precio_nuevo_centavos: precioNuevo,
        proration_behavior: direccion === 'upgrade' ? 'always_invoice' : 'create_prorations',
        invoice_id: cobro?.invoice_id ?? null,
        amount_paid_centavos: cobro?.amount_paid_centavos ?? null,
        moneda: cobro?.moneda ?? currency,
        recuperado: yaEnDestino
      },
      p_actor_usuario_id: socio.id
    });
    if (errCambio) {
      const m = errCambio.message;
      // Stripe ya cambió; EKKO no: la operación queda `fallida` y visible.
      if (m.includes('EKKO_OPERACION_CONFLICTO')) {
        await cerrar('fallida', 'operacion_conflicto');
        return rechazo('operacion_conflicto', 'Esta operación ya corresponde a otro cambio de plan. Vuelve a abrir el cambio.');
      }
      if (m.includes('EKKO_CUENTA_RESTRINGIDA')) {
        await cerrar('fallida', 'cuenta_restringida');
        return forbidden('Tu cuenta está suspendida por el estudio.');
      }
      // El reintento con la MISMA operación converge (recuperación).
      console.error('[cambiar-plan-suscripcion] transición', m);
      registrarOperacion({ funcion: FUNCION, kind: 'sub_mensual', usuario_id: socio.id, estado: 'db_pendiente' });
      await cerrar('fallida', 'db_pendiente');
      return rechazo('resultado_desconocido', 'Stripe aceptó el cambio pero no pudimos aplicarlo aún. Reintenta: no se cobrará dos veces.');
    }
    const c = (cambio ?? {}) as { idempotente?: boolean; tier_anterior?: string };
    // Stripe aplicó y EKKO convergió (la RPC lo verifica contra la membresía).
    await cerrar('aplicada', 'convergido', { direccion, recuperado: yaEnDestino, idempotente: c.idempotente === true });
    registrarOperacion({ funcion: FUNCION, kind: 'sub_mensual', usuario_id: socio.id, estado: c.idempotente ? 'aplicado:idempotente' : 'aplicado' });

    return ok({
      success: true,
      tier: tier.slug,
      tier_anterior: c.tier_anterior ?? null,
      direccion,
      idempotente: c.idempotente === true,
      recuperado: yaEnDestino,
      cobro
    });
  } catch (err) {
    console.error('[cambiar-plan-suscripcion]', err instanceof Error ? err.message : err);
    return serverError('No pudimos cambiar tu plan. Intenta de nuevo.');
  }
};

/** Cierra la operación durable. Nunca rompe la respuesta: si falla, lo que quedó
 * (pendiente) se ve en Operación al pasar una hora. */
async function cerrarCambioPlan(
  admin: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> },
  operationId: string,
  estado: 'aplicada' | 'descartada' | 'fallida',
  codigo: string,
  resultado: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await admin.rpc('cambio_plan_resultado', {
      p_operation_id: operationId,
      p_estado: estado,
      p_codigo: codigo,
      p_resultado: resultado
    });
    if (error) await reportarErrorServidor(FUNCION, new Error(error.message), { paso: 'cambio_plan_resultado', estado });
  } catch (e) {
    await reportarErrorServidor(FUNCION, e, { paso: 'cambio_plan_resultado', estado });
  }
}

function mensajeEstado(status: string): string {
  if (status === 'past_due' || status === 'unpaid') return 'Tu suscripción tiene un pago pendiente. Ponla al corriente antes de cambiar de plan.';
  if (status === 'pausada' || status === 'paused') return 'Tu suscripción está en pausa. Reanúdala antes de cambiar de plan.';
  return 'Tu suscripción no está en un estado que permita cambiar de plan. Acércate a recepción.';
}

/** Stripe rechazó el update por no poder cobrar (error_if_incomplete / tarjeta). */
function esFalloDeCobro(err: { type?: string; code?: string; message?: string }): boolean {
  if (err.type === 'StripeCardError') return true;
  const code = err.code ?? '';
  if (/card_declined|insufficient_funds|authentication_required|payment_intent_authentication_failure|invoice_payment_intent_requires_action|subscription_payment_intent_requires_action/.test(code)) return true;
  return err.type === 'StripeInvalidRequestError' && /payment|declin|incomplete|authenticat/i.test(err.message ?? '');
}

function transporte(clase: ReturnType<typeof clasificarErrorSaliente>): string {
  return clase === 'conflicto' ? 'resultado_desconocido' : clase;
}

