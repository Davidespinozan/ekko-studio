import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe, clasificarEvento, periodoFinFromSubscription, extraerMontoDeEvento } from '../_lib/stripe';
import { enviarEmail, emailPagoFallido, emailBienvenida, emailRecibo } from '../_lib/email';
import { reportarErrorServidor } from '../_lib/sentry';
import { avisarStaff } from '../_lib/avisosStaff';

/**
 * POST /stripe-webhook — materializa los cambios de la suscripción del miembro.
 *
 * Robustez (patrones de HSC):
 *   - Firma verificada sobre el BODY CRUDO (no JSON.parse).
 *   - Idempotencia: tabla `stripe_webhook_events` (PK = event.id). Si el evento
 *     ya se procesó → 200 duplicate. Si el procesamiento FALLA → borra el
 *     registro para que el reintento de Stripe lo reprocese.
 *   - Orden: el RPC `sync_membresia_stripe` ignora eventos más viejos.
 *
 * Activación (checkout.session.completed) → RPC `activar_membresia` (el MISMO
 * punto que usa recepción en mostrador). Cambios posteriores (renovó, falló el
 * pago, canceló) → RPC `sync_membresia_stripe`. Sin STRIPE_WEBHOOK_SECRET es
 * un no-op (no rompe el deploy).
 */

/**
 * Suscripciones de Stripe vivas del socio DISTINTAS de la nueva. Se consulta
 * ANTES de activar (activar_membresia cancela las filas), para poder cancelarlas
 * luego en Stripe y evitar doble cobro tras un cambio de plan.
 */
async function subsAnterioresDelSocio(
  admin: any,
  usuarioId: string,
  nuevaSubId: string | null | undefined
): Promise<string[]> {
  const { data } = await admin
    .from('membresias')
    .select('stripe_subscription_id')
    .eq('usuario_id', usuarioId)
    .in('status', ['trialing', 'activa', 'past_due'])
    .not('stripe_subscription_id', 'is', null);
  const rows = (data ?? []) as Array<{ stripe_subscription_id: string | null }>;
  const ids = rows
    .map((m) => m.stripe_subscription_id)
    .filter((id): id is string => !!id && id !== nuevaSubId);
  return [...new Set(ids)];
}

/** Cancela en Stripe cada suscripción anterior (best-effort; no rompe el webhook). */
async function cancelarSubsAnteriores(
  stripe: ReturnType<typeof getStripe>,
  subIds: string[],
  acctOpt: { stripeAccount: string } | undefined
): Promise<void> {
  for (const subId of subIds) {
    try {
      await stripe.subscriptions.cancel(subId, acctOpt);
    } catch (e) {
      console.error('[stripe-webhook] no se pudo cancelar sub anterior', subId, e instanceof Error ? e.message : e);
    }
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  // Webhook de Connect: el signing secret es el del endpoint de Connect
  // (STRIPE_CONNECT_WEBHOOK_SECRET); cae al genérico por compatibilidad.
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    return ok({ skipped: 'stripe_no_configurado' });
  }

  const stripe = getStripe();
  const sig = event.headers['stripe-signature'];
  if (!sig) return badRequest('Falta stripe-signature');

  // Body crudo: Netlify puede entregarlo en base64.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] firma inválida', err);
    return badRequest('Firma inválida');
  }

  const admin = createClient(
    requireEnv('VITE_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );

  // ── Cuenta ajena: la cuenta Stripe de la plataforma se comparte con otros
  //    productos (SALA, HSC). Un evento de una cuenta conectada que no es de
  //    ningún estudio de EKKO se responde 200 y se descarta (antes caía en
  //    activar_membresia con un usuario inexistente → 500 → reintentos).
  const connectedAccount = (stripeEvent as unknown as { account?: string }).account;
  if (connectedAccount) {
    const { data: tenantDeCuenta, error: tenantErr } = await admin
      .from('tenants')
      .select('id')
      .eq('stripe_account_id', connectedAccount)
      .maybeSingle();
    if (tenantErr) {
      console.error('[stripe-webhook] lookup tenant por cuenta', tenantErr.message);
      return serverError('No se pudo resolver la cuenta conectada');
    }
    if (!tenantDeCuenta) return ok({ received: true, ignored: 'cuenta_ajena' });
  }

  // ── Idempotencia: insert-or-ignore por event.id ───────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from('stripe_webhook_events')
    .upsert({ id: stripeEvent.id, type: stripeEvent.type }, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (insErr) {
    console.error('[stripe-webhook] idempotencia', insErr);
    return serverError('No se pudo registrar el evento');
  }
  if (!inserted || inserted.length === 0) {
    return ok({ received: true, duplicate: true });
  }

  // Connect: las lecturas a Stripe (retrieve de la suscripción) deben ir sobre
  // la cuenta conectada del evento.
  const acctOpt = connectedAccount ? { stripeAccount: connectedAccount } : undefined;

  try {
    const accion = clasificarEvento(stripeEvent);
    if (accion.kind === 'ignore' && accion.reason === 'app_ajena') {
      return ok({ received: true, ignored: 'app_ajena' });
    }
    // usuario del pago (para payment_events): se captura en cada rama donde ya
    // lo conocemos; en renovaciones (sync) se resuelve por la suscripción.
    let usuarioIdPago: string | null = null;

    if (accion.kind === 'activar') {
      // Mensual: leer la suscripción para el periodo_fin. Paquete (pago único):
      // no hay suscripción → periodo_fin lo decide activar_membresia por tipo.
      let periodoFin: string | null = null;
      if (accion.subscription_id) {
        const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
        periodoFin = periodoFinFromSubscription(sub);
      }
      const subsPrevias = await subsAnterioresDelSocio(admin, accion.usuario_id, accion.subscription_id);
      const { error } = await admin.rpc('activar_membresia', {
        p_usuario_id: accion.usuario_id,
        p_tier_id: accion.tier_id,
        p_stripe_subscription_id: accion.subscription_id,
        p_stripe_customer_id: accion.customer_id,
        p_periodo_fin: periodoFin
      });
      if (error) throw new Error(`activar_membresia: ${error.message}`);
      usuarioIdPago = accion.usuario_id;
      await cancelarSubsAnteriores(stripe, subsPrevias, acctOpt);
    } else if (accion.kind === 'activar-sub') {
      // Suscripción in-app (Elements): leer metadata + periodo de la suscripción,
      // sobre la cuenta conectada (Connect).
      const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
      const usuarioId = sub.metadata?.usuario_id;
      const tierId = sub.metadata?.tier_id;
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (usuarioId && tierId && customerId) {
        const subsPrevias = await subsAnterioresDelSocio(admin, usuarioId, accion.subscription_id);
        const { error } = await admin.rpc('activar_membresia', {
          p_usuario_id: usuarioId,
          p_tier_id: tierId,
          p_stripe_subscription_id: accion.subscription_id,
          p_stripe_customer_id: customerId,
          p_periodo_fin: periodoFinFromSubscription(sub)
        });
        if (error) throw new Error(`activar_membresia (sub): ${error.message}`);
        usuarioIdPago = usuarioId;
        // #2: cancelar la(s) suscripción(es) anterior(es) en Stripe para que el
        // miembro NO quede pagando dos mensualidades tras un cambio de plan.
        await cancelarSubsAnteriores(stripe, subsPrevias, acctOpt);
      }
    } else if (accion.kind === 'sync') {
      // M5: las renovaciones (invoice.paid) llegan sin periodo_fin → leerlo de la
      // suscripción para EXTENDER la vigencia (si no, el perfil queda con la fecha
      // vieja aunque el cobro mensual haya entrado).
      let periodoFin = accion.periodo_fin;
      if (!periodoFin && accion.subscription_id) {
        try {
          const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
          periodoFin = periodoFinFromSubscription(sub);
        } catch (e) {
          console.error('[stripe-webhook] periodo_fin de la sub', accion.subscription_id, e instanceof Error ? e.message : e);
        }
      }
      const { error } = await admin.rpc('sync_membresia_stripe', {
        p_stripe_subscription_id: accion.subscription_id,
        p_estado: accion.estado,
        p_periodo_fin: periodoFin,
        p_cancel_at_period_end: accion.cancel_at_period_end,
        p_event_at: accion.event_at
      });
      if (error) throw new Error(`sync_membresia_stripe: ${error.message}`);
    } else if (accion.kind === 'reembolso') {
      // Resolver al miembro por el cobro original (payment_events) y avisar al
      // equipo: un reembolso hecho desde el dashboard de Stripe no revierte
      // créditos ni membresía solo; alguien tiene que decidir.
      if (accion.payment_intent_id) {
        const { data: original } = await admin
          .from('payment_events')
          .select('usuario_id, tenant_id')
          .eq('stripe_payment_intent_id', accion.payment_intent_id)
          .eq('status', 'succeeded')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        usuarioIdPago = original?.usuario_id ?? null;
        if (original?.tenant_id) {
          await avisarStaff(admin, {
            tenant_id: original.tenant_id,
            tipo: 'reembolso',
            titulo: 'Reembolso en Stripe',
            mensaje: `Se reembolsaron ${(accion.amount_refunded / 100).toLocaleString('es-MX', { style: 'currency', currency: accion.currency.toUpperCase() })} de un cobro. Revisa si hay que ajustar créditos o la membresía del miembro.`,
            metadata: { charge_id: accion.charge_id, payment_intent_id: accion.payment_intent_id, usuario_id: usuarioIdPago },
            url: usuarioIdPago ? `/admin/miembros/${usuarioIdPago}` : '/admin/miembros',
            soloAdmins: true
          });
        }
      }
    } else if (accion.kind === 'cuenta-conectada') {
      // account.updated → refrescar el gate de cobro del estudio (antes solo lo
      // hacía connect-status cuando el admin abría /admin/cobros).
      const { error } = await admin
        .from('tenants')
        .update({
          stripe_charges_enabled: accion.charges_enabled,
          stripe_details_submitted: accion.details_submitted
        })
        .eq('stripe_account_id', accion.account_id);
      if (error) throw new Error(`tenants.update (account.updated): ${error.message}`);
    } else if (accion.kind === 'invitados-extra') {
      // Invitados extra pagados en la app → sumarlos a la reserva.
      const { error } = await admin.rpc('registrar_invitados_extra_pagados', {
        p_reserva_id: accion.reserva_id,
        p_cantidad: accion.cantidad
      });
      if (error) throw new Error(`registrar_invitados_extra_pagados: ${error.message}`);
      usuarioIdPago = accion.usuario_id;
    }
    // kind === 'ignore' → no-op (evento que no nos interesa).

    // ── Registrar el evento de cobranza en payment_events (métricas del admin) ─
    // Cobros exitosos (invoice.paid / payment_intent.succeeded) Y fallidos
    // (invoice.payment_failed → status='failed'). Falla suave: si no se puede
    // registrar, NO revierte la activación/sync ya hecha.
    const monto = extraerMontoDeEvento(stripeEvent);
    if (monto) {
      try {
        let tenantIdPago: string | null = null;
        // Renovación (sync): resolver usuario + tenant por la suscripción.
        if (!usuarioIdPago && monto.stripe_subscription_id) {
          const { data: mem } = await admin
            .from('membresias')
            .select('usuario_id, tenant_id')
            .eq('stripe_subscription_id', monto.stripe_subscription_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          usuarioIdPago = mem?.usuario_id ?? null;
          tenantIdPago = mem?.tenant_id ?? null;
        }
        if (usuarioIdPago && !tenantIdPago) {
          const { data: u } = await admin
            .from('usuarios')
            .select('tenant_id')
            .eq('id', usuarioIdPago)
            .maybeSingle();
          tenantIdPago = u?.tenant_id ?? null;
        }
        await admin.from('payment_events').upsert(
          {
            stripe_event_id: stripeEvent.id,
            stripe_event_type: stripeEvent.type,
            tenant_id: tenantIdPago,
            usuario_id: usuarioIdPago,
            monto_centavos: monto.monto_centavos,
            moneda: monto.moneda,
            status: monto.status,
            stripe_invoice_id: monto.stripe_invoice_id,
            stripe_payment_intent_id: monto.stripe_payment_intent_id,
            stripe_subscription_id: monto.stripe_subscription_id,
            stripe_customer_id: monto.stripe_customer_id,
            raw_payload: stripeEvent as unknown as Record<string, unknown>,
            processed_at: new Date().toISOString()
          },
          { onConflict: 'stripe_event_id', ignoreDuplicates: true }
        );

        // ── Aviso por email al miembro (best-effort, no-op sin Resend) ────────
        // Pago fallido → "actualizá tu tarjeta"; primer pago → bienvenida;
        // renovación → recibo. Solo para facturas de suscripción.
        if (usuarioIdPago) {
          const { data: u } = await admin
            .from('usuarios')
            .select('email, nombre')
            .eq('id', usuarioIdPago)
            .maybeSingle();
          const email = u?.email ?? null;
          if (email) {
            let estudio = 'EKKO Studio';
            if (tenantIdPago) {
              const { data: t } = await admin.from('tenants').select('nombre').eq('id', tenantIdPago).maybeSingle();
              if (t?.nombre) estudio = t.nombre;
            }
            const base = { estudio, nombre: u?.nombre ?? null, montoCentavos: monto.monto_centavos, moneda: monto.moneda };
            let tpl: { subject: string; html: string } | null = null;
            if (monto.status === 'failed') {
              tpl = emailPagoFallido(base);
              // El equipo también debe enterarse: dunning en mostrador.
              if (tenantIdPago) {
                await avisarStaff(admin, {
                  tenant_id: tenantIdPago,
                  tipo: 'cobro_rechazado',
                  titulo: 'Cobro rechazado',
                  mensaje: `La tarjeta de ${u?.nombre ?? email} rechazó el cobro de ${(monto.monto_centavos / 100).toLocaleString('es-MX', { style: 'currency', currency: monto.moneda.toUpperCase() })}. Stripe reintentará; si no, pídele que actualice su tarjeta.`,
                  metadata: { usuario_id: usuarioIdPago, stripe_invoice_id: monto.stripe_invoice_id },
                  url: `/admin/miembros/${usuarioIdPago}`
                });
              }
            } else if (monto.status === 'succeeded' && stripeEvent.type === 'invoice.paid') {
              const inv = stripeEvent.data.object as { billing_reason?: string };
              tpl = inv?.billing_reason === 'subscription_create' ? emailBienvenida(base) : emailRecibo(base);
            }
            if (tpl) await enviarEmail({ to: email, subject: tpl.subject, html: tpl.html });
          }
        }
      } catch (pagoErr) {
        console.error('[stripe-webhook] no se pudo registrar payment_events/email', pagoErr);
      }
    }

    return ok({ received: true });
  } catch (err) {
    // Borrar el registro de idempotencia para que Stripe reintente y reprocese.
    await admin.from('stripe_webhook_events').delete().eq('id', stripeEvent.id);
    await reportarErrorServidor('stripe-webhook', err, { event_id: stripeEvent.id, type: stripeEvent.type, account: connectedAccount ?? null });
    return serverError(err instanceof Error ? err.message : 'webhook error');
  }
};
