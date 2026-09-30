import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe, llavePrecio } from '../_lib/stripe';
import { resolverCuentaConectada, getOrCreateSocioCustomer } from '../_lib/connectBilling';
import {
  crearPresupuesto,
  leerOperationId,
  llaveOperacion,
  llaveInvalidacion,
  ejecutarOperacion,
  clasificarPaymentIntent,
  clasificarSuscripcion,
  clasificarErrorSaliente,
  evidenciaPagoInicial,
  porOperacion,
  registrarOperacion,
  crearSesionCliente,
  PresupuestoAgotado,
  type Presupuesto,
  type ResultadoOperacion,
  type KindOperacion
} from '../_lib/operacionPago';
import type Stripe from 'stripe';

/**
 * POST /crear-pago-intent
 * Auth: Bearer JWT del miembro. Body: { tier: <slug> }
 *
 * Pago IN-APP con Stripe ELEMENTS (formulario oscuro propio de EKKO), sobre la
 * CUENTA CONECTADA del estudio (direct charge). Devuelve { clientSecret, account }:
 *   - Mensual → subscription `default_incomplete` (precio creado en la cuenta
 *     conectada; client_secret de la 1ª factura → cobro inmediato + 3DS in-modal).
 *   - Paquete → PaymentIntent (pago único).
 * El front confirma con <PaymentElement>. La activación la dispara el webhook.
 *   - Sin STRIPE_SECRET_KEY        → { reason: 'stripe_pendiente' }.
 *   - Estudio sin cobros activados → { reason: 'cobros_no_activos' }.
 *
 * PKG-01C: con `operation_id` (UUID, uno por intención de compra) la creación es
 * idempotente por OPERACIÓN: se busca primero el objeto de esa operación y se
 * clasifica por su estado observable; si no existe, se crea con la key estable
 * `ekko:v1:<kind>:<acct>:<usuario>:<operation_id>`. La respuesta lleva `estado`
 * (reutilizable | en_proceso | ya_pagado | reemplazable | requiere_revision |
 * desconocido | operacion_invalida | reintentable | resultado_desconocido |
 * pago_no_iniciable | cobros_no_disponibles). Sin `operation_id` = cliente legacy:
 * comportamiento anterior, marcado para diagnóstico (ventana transitoria).
 */

interface Body {
  tier?: string;
  operation_id?: unknown;
}

const FUNCION = 'crear-pago-intent';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');
  // Presupuesto interno desde el inicio del handler (no es el límite de la plataforma).
  const presupuesto = crearPresupuesto();

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    if (!body.tier) return badRequest('tier requerido');
    const operacion = leerOperationId(body.operation_id);
    if (operacion.tipo === 'invalido') return badRequest('operation_id inválido');

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
      .select('id, tenant_id, rol, email, status, sancionado_at')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    // Una sanción del estudio no se compra: el pago crearía la membresía y el
    // trigger dejaría la cuenta suspendida de todos modos (Fase 1 identidad).
    if (socio.sancionado_at || socio.status === 'revocado') {
      return forbidden('Tu cuenta está suspendida por el estudio. Escríbenos para resolverlo antes de comprar un plan.');
    }
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede pagar su membresía');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: tier } = await admin
      .from('tiers')
      .select('id, slug, activo, en_venta, tenant_id, nombre, precio_centavos, moneda, tipo')
      .eq('tenant_id', socio.tenant_id)
      .eq('slug', body.tier)
      .maybeSingle();
    if (!tier || tier.tenant_id !== socio.tenant_id || tier.activo !== true) {
      return badRequest('Plan inválido');
    }
    // `en_venta=false` = el estudio dejó de VENDER el plan (sus miembros actuales
    // lo conservan). La landing y el perfil ya no lo muestran, pero sin este
    // chequeo seguía siendo comprable llamando a la API con el slug.
    if (tier.en_venta === false) {
      return badRequest('Este plan ya no está a la venta');
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ reason: 'stripe_pendiente' });
    }

    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) {
      return ok({ reason: 'cobros_no_activos' });
    }
    if (!Number.isInteger(tier.precio_centavos) || tier.precio_centavos <= 0) {
      return badRequest('Este plan no tiene un precio válido');
    }

    const stripe = getStripe();
    const opt = { stripeAccount: accountId };
    const currency = (tier.moneda || 'mxn').toLowerCase();
    const esPaquete = tier.tipo === 'creditos' || tier.tipo === 'hibrido';
    // Comisión de la plataforma (EKKO_FEE_PERCENT, default 0). Antes solo se
    // aplicaba en el Checkout (fallback); los flujos Elements no cobraban fee.
    const feePct = Number(optionalEnv('EKKO_FEE_PERCENT', '0')) || 0;

    if (operacion.tipo === 'ausente') {
      return await legacy({ stripe, admin, socio, accountId, tier, currency, esPaquete, feePct });
    }

    // ── PKG-01C: operación idempotente ─────────────────────────────────────
    const operationId = operacion.id;
    const kind: KindOperacion = esPaquete ? 'pi_paquete' : 'sub_mensual';
    const target = `${esPaquete ? 'paquete' : 'mensual'}:${tier.id}`;
    const key = llaveOperacion(kind, accountId, socio.id, operationId);
    const metadata = { app: 'ekko', usuario_id: socio.id, tier_id: tier.id, operation_id: operationId, ekko_target: target };

    let customerId: string;
    try {
      customerId = await getOrCreateSocioCustomer(
        stripe,
        admin,
        { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
        accountId,
        { presupuesto }
      );
    } catch (e) {
      const estado = clasificarErrorSaliente(e, 'mutacion');
      return responderTransporte(estado === 'conflicto' ? 'resultado_desconocido' : estado, operationId, kind, socio.id);
    }

    if (esPaquete) {
      const amount = tier.precio_centavos;
      const fee = feePct > 0 ? Math.round((amount * feePct) / 100) : 0;
      const esperado = { target, amount, currency, fee, metadata: { tier_id: tier.id, usuario_id: socio.id } };
      const res = await ejecutarOperacion<Stripe.PaymentIntent>(
        {
          buscar: async () => {
            const lista = await stripe.paymentIntents.list({ customer: customerId, limit: 100 }, { ...opt, ...presupuesto.opcionesLectura() });
            return porOperacion(lista.data, operationId);
          },
          crear: () =>
            stripe.paymentIntents.create(
              {
                amount,
                currency,
                customer: customerId,
                metadata,
                automatic_payment_methods: { enabled: true },
                ...(fee > 0 ? { application_fee_amount: fee } : {})
              },
              { ...opt, idempotencyKey: key, ...presupuesto.opcionesMutacion() }
            ),
          evaluar: async (pi) => clasificarPaymentIntent(pi, esperado),
          invalidar: (pi) =>
            stripe.paymentIntents.cancel(pi.id, {}, { ...opt, idempotencyKey: llaveInvalidacion(kind, accountId, socio.id, operationId), ...presupuesto.opcionesMutacion() }),
          releer: (pi) => stripe.paymentIntents.retrieve(pi.id, {}, { ...opt, ...presupuesto.opcionesLectura() })
        },
        presupuesto
      );
      return await responder(res, {
        operationId, kind, usuarioId: socio.id, accountId, modo: 'pago',
        secreto: (pi) => pi.client_secret,
        monto: (pi) => ({ monto: pi.amount, moneda: pi.currency }),
        stripe, customerId, presupuesto
      });
    }

    // Mensual: el precio recurrente debe existir EN la cuenta conectada.
    const amount = tier.precio_centavos;
    const esperado = { target, amount, currency, fee: feePct > 0 ? feePct : 0, metadata: { tier_id: tier.id, usuario_id: socio.id } };
    const res = await ejecutarOperacion<Stripe.Subscription>(
      {
        buscar: async () => {
          const lista = await stripe.subscriptions.list(
            { customer: customerId, status: 'all', limit: 100, expand: ['data.latest_invoice.confirmation_secret'] },
            { ...opt, ...presupuesto.opcionesLectura() }
          );
          return porOperacion(lista.data, operationId);
        },
        crear: async () => {
          // prices.create con product_data lo crea inline (idempotente por tier+precio).
          const price = await stripe.prices.create(
            {
              unit_amount: amount,
              currency,
              recurring: { interval: 'month' },
              product_data: { name: tier.nombre }
            },
            { ...opt, idempotencyKey: llavePrecio({ tierId: tier.id, accountId, centavos: amount, currency, nombre: tier.nombre }), ...presupuesto.opcionesMutacion() }
          );
          if (!presupuesto.puedeMutar()) throw new PresupuestoAgotado(); // la sub aún no se envió
          return stripe.subscriptions.create(
            {
              customer: customerId,
              items: [{ price: price.id }],
              payment_behavior: 'default_incomplete',
              payment_settings: { save_default_payment_method: 'on_subscription' },
              metadata,
              ...(feePct > 0 ? { application_fee_percent: feePct } : {}),
              expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret']
            },
            { ...opt, idempotencyKey: key, ...presupuesto.opcionesMutacion() }
          );
        },
        evaluar: async (sub) => clasificarSuscripcion(sub, esperado, await evidenciaPagoInicial(stripe, sub, opt, presupuesto))
      },
      presupuesto
    );
    return await responder(res, {
      operationId, kind, usuarioId: socio.id, accountId, modo: 'suscripcion',
      secreto: (sub) => secretoPrimeraFactura(sub),
      monto: (sub) => ({ monto: sub.items?.data?.[0]?.price?.unit_amount ?? null, moneda: sub.items?.data?.[0]?.price?.currency ?? currency }),
      stripe, customerId, presupuesto
    });
  } catch (err) {
    console.error('[crear-pago-intent]', err instanceof Error ? err.message : err);
    return serverError('No pudimos preparar el pago. Intenta de nuevo.');
  }
};

function secretoPrimeraFactura(sub: Stripe.Subscription): string | null {
  const inv = sub.latest_invoice as unknown as {
    payment_intent?: { client_secret?: string } | string | null;
    confirmation_secret?: { client_secret?: string } | null;
  } | null;
  if (!inv || typeof inv !== 'object') return null;
  const pi = typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  return inv.confirmation_secret?.client_secret ?? pi?.client_secret ?? null;
}

function responderTransporte(estado: string, operationId: string, kind: KindOperacion, usuarioId: string) {
  registrarOperacion({ funcion: FUNCION, kind, usuario_id: usuarioId, estado });
  return ok({ estado, operationId });
}


async function responder<T extends { id: string; created: number }>(
  res: ResultadoOperacion<T>,
  c: {
    operationId: string;
    kind: KindOperacion;
    usuarioId: string;
    accountId: string;
    modo: 'pago' | 'suscripcion';
    secreto: (o: T) => string | null;
    monto: (o: T) => { monto: number | null; moneda: string };
    stripe: Stripe;
    customerId: string;
    presupuesto: Presupuesto;
  }
) {
  if (res.tipo === 'transporte') return responderTransporte(res.veredicto, c.operationId, c.kind, c.usuarioId);
  const base = { operationId: c.operationId, objetoId: res.objeto.id, creadoEn: res.objeto.created * 1000 };
  if (res.veredicto === 'reutilizable') {
    const clientSecret = c.secreto(res.objeto);
    if (!clientSecret) {
      registrarOperacion({ funcion: FUNCION, kind: c.kind, usuario_id: c.usuarioId, estado: 'requiere_revision', drift: res.drift });
      return ok({ ...base, estado: 'requiere_revision' });
    }
    registrarOperacion({ funcion: FUNCION, kind: c.kind, usuario_id: c.usuarioId, estado: 'reutilizable', drift: res.drift });
    const customerSessionClientSecret = await crearSesionCliente(c.stripe, c.customerId, c.accountId, 'crear-pago-intent', c.presupuesto);
    return ok({
      ...base,
      estado: 'reutilizable',
      clientSecret,
      account: c.accountId,
      modo: c.modo,
      customerSessionClientSecret,
      // Importe REAL del objeto (si la operación es anterior a un cambio de precio, la UI lo muestra tal cual).
      ...c.monto(res.objeto),
      ...(c.modo === 'suscripcion' ? { subscriptionId: res.objeto.id } : {})
    });
  }
  registrarOperacion({ funcion: FUNCION, kind: c.kind, usuario_id: c.usuarioId, estado: res.veredicto, drift: res.drift });
  return ok({ ...base, estado: res.veredicto });
}

/**
 * Cliente LEGACY (sin operation_id), ventana transitoria (D-01C-2): comportamiento
 * anterior sin idempotencia inventada. Marca diagnóstica `ekko_op: 'legacy'` en la
 * metadata (NO es operation_id ni key) y log estructurado sin PII.
 */
async function legacy(c: {
  stripe: Stripe;
  admin: any;
  socio: { id: string; tenant_id: string; email: string | null };
  accountId: string;
  tier: { id: string; nombre: string; precio_centavos: number };
  currency: string;
  esPaquete: boolean;
  feePct: number;
}) {
  const { stripe, admin, socio, accountId, tier, currency, esPaquete, feePct } = c;
  const opt = { stripeAccount: accountId };
  registrarOperacion({ funcion: FUNCION, kind: esPaquete ? 'pi_paquete' : 'sub_mensual', usuario_id: socio.id, estado: 'legacy', legacy: true });
  const customerId = await getOrCreateSocioCustomer(
    stripe,
    admin,
    { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
    accountId
  );

  // CustomerSession → el <PaymentElement> muestra la tarjeta guardada para
  // pagar de un tap (recompra sin re-teclear). El filtro incluye 'unspecified'
  // porque las tarjetas guardadas por la suscripción quedan con ese
  // allow_redisplay y si no, no se listarían.
  const customerSessionClientSecret = await crearSesionCliente(stripe, customerId, accountId, 'crear-pago-intent');

  const metadata = { app: 'ekko', usuario_id: socio.id, tier_id: tier.id, ekko_op: 'legacy' };

  if (esPaquete) {
    const intent = await stripe.paymentIntents.create(
      {
        amount: tier.precio_centavos,
        currency,
        customer: customerId,
        metadata,
        automatic_payment_methods: { enabled: true },
        ...(feePct > 0 ? { application_fee_amount: Math.round((tier.precio_centavos * feePct) / 100) } : {})
      },
      opt
    );
    return ok({ clientSecret: intent.client_secret, account: accountId, modo: 'pago', customerSessionClientSecret });
  }

  // Mensual: el precio recurrente debe existir EN la cuenta conectada.
  // prices.create con product_data lo crea inline (idempotente por tier+cuenta).
  const price = await stripe.prices.create(
    {
      unit_amount: tier.precio_centavos,
      currency,
      recurring: { interval: 'month' },
      product_data: { name: tier.nombre }
    },
    { ...opt, idempotencyKey: llavePrecio({ tierId: tier.id, accountId, centavos: tier.precio_centavos, currency, nombre: tier.nombre }) }
  );

  const sub = await stripe.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: price.id }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata,
      ...(feePct > 0 ? { application_fee_percent: feePct } : {}),
      expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret']
    },
    opt
  );

  const clientSecret = secretoPrimeraFactura(sub);
  if (!clientSecret) return serverError('No se pudo iniciar el cobro de la suscripción');

  return ok({ clientSecret, account: accountId, modo: 'suscripcion', subscriptionId: sub.id, customerSessionClientSecret });
}
