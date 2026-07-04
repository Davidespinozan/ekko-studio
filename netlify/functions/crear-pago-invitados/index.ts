import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden, notFound, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada, getOrCreateSocioCustomer } from '../_lib/connectBilling';

/**
 * POST /crear-pago-invitados
 * Auth: Bearer JWT del miembro. Body: { reserva_id, cantidad }.
 *
 * Pago IN-APP (Elements + tarjeta guardada) de N invitados EXTRA de una reserva,
 * sobre la cuenta conectada del estudio. Pago único (PaymentIntent). El webhook
 * (payment_intent.succeeded, tipo='invitados_extra') suma los extras pagados a la
 * reserva. Todo por Stripe — nada de efectivo/terminal en mostrador.
 */

interface Body {
  reserva_id?: string;
  cantidad?: number;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const cantidad = Number(body.cantidad);
    if (!body.reserva_id) return badRequest('reserva_id requerido');
    if (!Number.isInteger(cantidad) || cantidad <= 0) return badRequest('cantidad inválida');

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
    if (yaPagados + cantidad > maxExtra) {
      return badRequest(`Este estudio permite máximo ${maxExtra} invitados extra por reserva (ya pagaste ${yaPagados})`);
    }

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
    const customerId = await getOrCreateSocioCustomer(
      stripe,
      admin,
      { id: socio.id, tenant_id: socio.tenant_id, email: socio.email ?? null },
      accountId
    );

    let customerSessionClientSecret: string | null = null;
    try {
      const cs = await stripe.customerSessions.create(
        {
          customer: customerId,
          components: {
            payment_element: {
              enabled: true,
              features: {
                payment_method_redisplay: 'enabled',
                payment_method_allow_redisplay_filters: ['always', 'limited', 'unspecified'],
                payment_method_save: 'enabled',
                payment_method_save_usage: 'off_session',
                payment_method_remove: 'enabled'
              }
            }
          }
        },
        opt
      );
      customerSessionClientSecret = cs.client_secret;
    } catch (e) {
      console.error('[crear-pago-invitados] customerSession', e instanceof Error ? e.message : e);
    }

    const intent = await stripe.paymentIntents.create(
      {
        amount: precioExtra * cantidad,
        currency: 'mxn',
        customer: customerId,
        automatic_payment_methods: { enabled: true },
        metadata: {
          app: 'ekko',
          tipo: 'invitados_extra',
          reserva_id: reserva.id,
          cantidad: String(cantidad),
          usuario_id: socio.id
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
  } catch (err) {
    console.error('[crear-pago-invitados]', err instanceof Error ? err.message : err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
