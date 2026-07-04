import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';

/**
 * POST /stripe-actualizar-tarjeta
 * Auth: Bearer JWT del miembro. Body: { payment_method: 'pm_...' }.
 *
 * Fija el nuevo método de pago (recién guardado por el SetupIntent) como default
 * del customer y de la suscripción activa, sobre la cuenta conectada. El pm SIEMPRE
 * se valida contra el customer del miembro (derivado del JWT) antes de asignarlo.
 */

interface Body {
  payment_method?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    const body: Body = JSON.parse(event.body || '{}');
    const pmId = body.payment_method;
    if (!pmId || !pmId.startsWith('pm_')) return badRequest('payment_method inválido');

    if (!process.env.STRIPE_SECRET_KEY) return badRequest('Pagos no configurados');

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
      .select('id, tenant_id')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!socio) return unauthorized('Sin perfil');

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: dp } = await admin
      .from('usuarios_datos_privados')
      .select('stripe_customer_id')
      .eq('usuario_id', socio.id)
      .maybeSingle();
    const { data: mem } = await admin
      .from('membresias')
      .select('stripe_subscription_id, stripe_customer_id')
      .eq('usuario_id', socio.id)
      .in('status', ['trialing', 'activa', 'past_due'])
      .not('stripe_subscription_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const customerId = dp?.stripe_customer_id ?? mem?.stripe_customer_id ?? null;
    if (!customerId) return badRequest('No tenés un método de pago que actualizar');

    const { accountId } = await resolverCuentaConectada(admin, socio.tenant_id);
    if (!accountId) return badRequest('El estudio no tiene cobros activados');

    const stripe = getStripe();
    const acctOpt = { stripeAccount: accountId };

    // El pm debe pertenecer al customer del miembro (evita asignar el de otro).
    const pm = await stripe.paymentMethods.retrieve(pmId, acctOpt);
    if (pm.customer && pm.customer !== customerId) {
      return badRequest('Ese método de pago no es tuyo');
    }
    if (!pm.customer) {
      await stripe.paymentMethods.attach(pmId, { customer: customerId }, acctOpt);
    }

    await stripe.customers.update(
      customerId,
      { invoice_settings: { default_payment_method: pmId } },
      acctOpt
    );

    let reintentado = false;
    if (mem?.stripe_subscription_id) {
      const sub = await stripe.subscriptions.update(
        mem.stripe_subscription_id,
        { default_payment_method: pmId },
        acctOpt
      );

      // Si el pago estaba vencido (past_due), reintentar cobrar la última factura
      // con la nueva tarjeta ahora mismo — así el acceso se restablece sin esperar
      // el reintento automático de Stripe. Best-effort: si falla, no rompe el
      // guardado de la tarjeta (Stripe reintentará por su cuenta).
      const latestInvoice = (sub as unknown as { latest_invoice?: string | { id: string } | null }).latest_invoice;
      const invoiceId = typeof latestInvoice === 'string' ? latestInvoice : latestInvoice?.id;
      if (sub.status === 'past_due' && invoiceId) {
        try {
          await stripe.invoices.pay(invoiceId, { payment_method: pmId }, acctOpt);
          reintentado = true;
        } catch (payErr) {
          console.error('[stripe-actualizar-tarjeta] reintento de cobro', payErr instanceof Error ? payErr.message : payErr);
        }
      }
    }

    return ok({ success: true, reintentado });
  } catch (err) {
    console.error('[stripe-actualizar-tarjeta]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
