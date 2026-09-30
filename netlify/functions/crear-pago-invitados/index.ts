import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, notFound, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada, getOrCreateSocioCustomer } from '../_lib/connectBilling';
import {
  crearPresupuesto,
  leerOperationId,
  llaveOperacion,
  llaveInvalidacion,
  ejecutarOperacion,
  clasificarPaymentIntent,
  clasificarErrorSaliente,
  porOperacion,
  registrarOperacion,
  crearSesionCliente,
  RechazoNegocio
} from '../_lib/operacionPago';
import type Stripe from 'stripe';

/**
 * POST /crear-pago-invitados
 * Auth: Bearer JWT del miembro. Body: { reserva_id, cantidad }.
 *
 * Pago IN-APP (Elements + tarjeta guardada) de N invitados EXTRA de una reserva,
 * sobre la cuenta conectada del estudio. Pago único (PaymentIntent). El webhook
 * (payment_intent.succeeded, tipo='invitados_extra') suma los extras pagados a la
 * reserva. Todo por Stripe — nada de efectivo/terminal en mostrador.
 *
 * PKG-01C: con `operation_id` la compra es idempotente por OPERACIÓN (key
 * `ekko:v1:pi_invitados:<acct>:<usuario>:<operation_id>`). Un reintento de la
 * misma compra devuelve el mismo PaymentIntent; una segunda compra legítima trae
 * otro operation_id. El tope de invitados se valida al CREAR (una operación ya
 * existente se recupera y clasifica aunque sus invitados ya cuenten en el tope).
 * Sin `operation_id` = cliente legacy (ventana transitoria).
 */

interface Body {
  reserva_id?: string;
  cantidad?: number;
  operation_id?: unknown;
}

const FUNCION = 'crear-pago-invitados';
const KIND = 'pi_invitados' as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');
  // Presupuesto interno desde el inicio del handler (no es el límite de la plataforma).
  const presupuesto = crearPresupuesto();

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const cantidad = Number(body.cantidad);
    if (!body.reserva_id) return badRequest('reserva_id requerido');
    if (!Number.isInteger(cantidad) || cantidad <= 0) return badRequest('cantidad inválida');
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
      .select('id, tenant_id, rol, email')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');
    if (socio.rol !== 'miembro') return badRequest('Solo un miembro puede pagar sus invitados');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // La reserva debe ser del miembro y de su tenant.
    const { data: reserva } = await admin
      .from('reservas')
      .select('id, tenant_id, usuario_id, status, recurso_id, invitados_extra_pagados')
      .eq('id', body.reserva_id)
      .maybeSingle();
    if (!reserva) return notFound('Reserva no encontrada');
    if (reserva.usuario_id !== socio.id || reserva.tenant_id !== socio.tenant_id) {
      return forbidden('Esa reserva no es tuya');
    }
    if (reserva.status !== 'confirmada') {
      return badRequest('Solo puedes pagar invitados de una reserva vigente');
    }

    // Tope de invitados extra del estudio (fuente de verdad). No permitir pasar
    // de max: ya pagados + esta compra ≤ max_invitados_extra.
    const { data: recurso } = await admin
      .from('recursos')
      .select('max_invitados_extra')
      .eq('id', reserva.recurso_id)
      .maybeSingle();
    const maxExtra = Number(recurso?.max_invitados_extra) || 0;
    const yaPagados = Number(reserva.invitados_extra_pagados) || 0;
    if (maxExtra <= 0) return badRequest('Este estudio no admite invitados extra');
    const errorCupo =
      yaPagados + cantidad > maxExtra
        ? `Este estudio permite máximo ${maxExtra} invitados extra por reserva (ya pagaste ${yaPagados})`
        : null;
    if (errorCupo && operacion.tipo === 'ausente') return badRequest(errorCupo);

    // Precio por invitado extra (config del tenant).
    const { data: tenant } = await admin.from('tenants').select('config').eq('id', socio.tenant_id).maybeSingle();
    const cfgReserva = ((tenant?.config as Record<string, unknown> | null)?.reserva ?? {}) as Record<string, unknown>;
    const precioExtra = Number(cfgReserva.precio_invitado_extra_centavos) || 0;
    if (precioExtra <= 0) return badRequest('El estudio no configuró el precio de invitado extra');

    if (!process.env.STRIPE_SECRET_KEY) return ok({ reason: 'stripe_pendiente' });

    const { accountId, chargesEnabled } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId || !chargesEnabled) return ok({ reason: 'cobros_no_activos' });

    const stripe = getStripe();
    const opt = { stripeAccount: accountId };
    const feePct = Number(optionalEnv('EKKO_FEE_PERCENT', '0')) || 0;
    const amount = precioExtra * cantidad;
    const fee = feePct > 0 ? Math.round((amount * feePct) / 100) : 0;

    if (operacion.tipo === 'ausente') {
      // ── Cliente LEGACY (D-01C-2): comportamiento anterior, sin idempotencia inventada.
      registrarOperacion({ funcion: FUNCION, kind: KIND, usuario_id: socio.id, estado: 'legacy', legacy: true });
      const customerId = await getOrCreateSocioCustomer(
        stripe,
        admin,
        { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
        accountId
      );
      const customerSessionClientSecret = await crearSesionCliente(stripe, customerId, accountId, 'crear-pago-invitados');
      const intent = await stripe.paymentIntents.create(
        {
          amount,
          currency: 'mxn',
          customer: customerId,
          automatic_payment_methods: { enabled: true },
          ...(fee > 0 ? { application_fee_amount: fee } : {}),
          metadata: {
            app: 'ekko',
            tipo: 'invitados_extra',
            reserva_id: reserva.id,
            cantidad: String(cantidad),
            usuario_id: socio.id,
            ekko_op: 'legacy'
          }
        },
        opt
      );
      return ok({
        clientSecret: intent.client_secret,
        account: accountId,
        modo: 'pago',
        customerSessionClientSecret
      });
    }

    // ── PKG-01C: operación idempotente ───────────────────────────────────────
    const operationId = operacion.id;
    const target = `invitados:${reserva.id}`;
    const key = llaveOperacion(KIND, accountId, socio.id, operationId);
    const transporte = (estado: string) => {
      registrarOperacion({ funcion: FUNCION, kind: KIND, usuario_id: socio.id, estado });
      return ok({ estado, operationId });
    };

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
      return transporte(estado === 'conflicto' ? 'resultado_desconocido' : estado);
    }

    const esperado = {
      target,
      amount,
      currency: 'mxn',
      fee,
      metadata: { tipo: 'invitados_extra', reserva_id: reserva.id, cantidad: String(cantidad), usuario_id: socio.id }
    };

    let res;
    try {
      res = await ejecutarOperacion<Stripe.PaymentIntent>(
        {
          buscar: async () => {
            const lista = await stripe.paymentIntents.list({ customer: customerId, limit: 100 }, { ...opt, ...presupuesto.opcionesLectura() });
            return porOperacion(lista.data, operationId);
          },
          crear: () => {
            // El tope solo aplica a una compra NUEVA (nada se envió a Stripe todavía).
            if (errorCupo) throw new RechazoNegocio(errorCupo);
            return stripe.paymentIntents.create(
              {
                amount,
                currency: 'mxn',
                customer: customerId,
                automatic_payment_methods: { enabled: true },
                ...(fee > 0 ? { application_fee_amount: fee } : {}),
                metadata: {
                  app: 'ekko',
                  tipo: 'invitados_extra',
                  reserva_id: reserva.id,
                  cantidad: String(cantidad),
                  usuario_id: socio.id,
                  operation_id: operationId,
                  ekko_target: target
                }
              },
              { ...opt, idempotencyKey: key, ...presupuesto.opcionesMutacion() }
            );
          },
          evaluar: async (pi) => clasificarPaymentIntent(pi, esperado),
          invalidar: (pi) =>
            stripe.paymentIntents.cancel(pi.id, {}, { ...opt, idempotencyKey: llaveInvalidacion(KIND, accountId, socio.id, operationId), ...presupuesto.opcionesMutacion() }),
          releer: (pi) => stripe.paymentIntents.retrieve(pi.id, {}, { ...opt, ...presupuesto.opcionesLectura() })
        },
        presupuesto
      );
    } catch (e) {
      if (e instanceof RechazoNegocio) return badRequest(e.message);
      throw e;
    }

    if (res.tipo === 'transporte') return transporte(res.veredicto);
    const pi = res.objeto;
    const base = { operationId, objetoId: pi.id, creadoEn: pi.created * 1000 };
    registrarOperacion({ funcion: FUNCION, kind: KIND, usuario_id: socio.id, estado: res.veredicto, drift: res.drift });
    if (res.veredicto === 'reutilizable' && pi.client_secret) {
      const customerSessionClientSecret = await crearSesionCliente(stripe, customerId, accountId, 'crear-pago-invitados', presupuesto);
      return ok({
        ...base,
        estado: 'reutilizable',
        clientSecret: pi.client_secret,
        account: accountId,
        modo: 'pago',
        customerSessionClientSecret,
        monto: pi.amount,
        moneda: pi.currency
      });
    }
    return ok({ ...base, estado: res.veredicto === 'reutilizable' ? 'requiere_revision' : res.veredicto });
  } catch (err) {
    console.error('[crear-pago-invitados]', err instanceof Error ? err.message : err);
    return serverError('No pudimos preparar el pago. Intenta de nuevo.');
  }
};

