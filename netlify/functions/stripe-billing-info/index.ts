import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';

/**
 * POST /stripe-billing-info
 * Auth: Bearer JWT del miembro. Body: {} (ninguno).
 *
 * Devuelve la tarjeta registrada (brand/last4/exp) y el historial de cobros
 * del miembro, leídos de Stripe SOBRE la cuenta conectada del estudio (Connect).
 * Solo lectura. El customer SIEMPRE se deriva del JWT (nunca del body) para que
 * nadie lea la tarjeta/pagos de otro. Los miembros no pueden leer payment_events
 * (RLS admin-only) → por eso el historial viene de acá, no de la tabla.
 *
 * Sin Stripe configurado o sin customer → { paymentMethod: null, pagos: [] }.
 */

interface Pago {
  id: string;
  monto_centavos: number;
  moneda: string;
  fecha: string;
  status: string; // 'succeeded' | 'pending' | 'failed'
  descripcion: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token de sesión');
    const userToken = authHeader.slice('Bearer '.length);

    if (!process.env.STRIPE_SECRET_KEY) {
      return ok({ paymentMethod: null, pagos: [], reason: 'stripe_pendiente' });
    }

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
    const { data: tenant } = await admin
      .from('tenants')
      .select('stripe_account_id')
      .eq('id', socio.tenant_id)
      .maybeSingle();

    // El customer puede estar en usuarios_datos_privados (pago in-app) o solo en
    // membresias (activación en recepción / portal). Probar ambos.
    let customerId = dp?.stripe_customer_id ?? null;
    if (!customerId) {
      const { data: mem } = await admin
        .from('membresias')
        .select('stripe_customer_id')
        .eq('usuario_id', socio.id)
        .not('stripe_customer_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      customerId = mem?.stripe_customer_id ?? null;
    }
    const stripeAccount = tenant?.stripe_account_id ?? null;

    // Diagnóstico temporal (no sensible): de dónde salió el customer, si hay
    // cuenta conectada, y errores de Stripe. Se loguea en el cliente.
    const debug: Record<string, unknown> = {
      customerSource: dp?.stripe_customer_id ? 'datos_privados' : customerId ? 'membresias' : 'none',
      hasCustomer: !!customerId,
      hasAccount: !!stripeAccount,
      errors: [] as string[]
    };

    if (!customerId || !stripeAccount) {
      return ok({ paymentMethod: null, pagos: [], debug });
    }

    const stripe = getStripe();
    const acctOpt = { stripeAccount };

    // ── Tarjeta default (o la primera adjunta como fallback) ─────────────────
    let paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null = null;
    try {
      const customer = await stripe.customers.retrieve(
        customerId,
        { expand: ['invoice_settings.default_payment_method'] },
        acctOpt
      );
      let pm = (customer as any)?.invoice_settings?.default_payment_method;
      if (!pm?.card) {
        const list = await stripe.paymentMethods.list(
          { customer: customerId, type: 'card', limit: 1 },
          acctOpt
        );
        pm = list.data[0] ?? null;
      }
      const card = pm?.card;
      if (card) {
        paymentMethod = { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[stripe-billing-info] payment method', msg);
      (debug.errors as string[]).push(`pm: ${msg}`);
    }

    // ── Historial: charges (cubre suscripción Y paquetes de una sola vez) ─────
    const pagos: Pago[] = [];
    try {
      const charges = await stripe.charges.list({ customer: customerId, limit: 12 }, acctOpt);
      for (const ch of charges.data) {
        if (ch.amount == null) continue;
        const status = ch.status === 'succeeded' ? 'succeeded' : ch.status === 'pending' ? 'pending' : 'failed';
        pagos.push({
          id: ch.id,
          monto_centavos: ch.amount,
          moneda: ch.currency ?? 'mxn',
          fecha: new Date(ch.created * 1000).toISOString(),
          status,
          descripcion: ch.description ?? 'Cobro'
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[stripe-billing-info] charges', msg);
      (debug.errors as string[]).push(`charges: ${msg}`);
    }

    debug.cardFound = !!paymentMethod;
    debug.chargesCount = pagos.length;
    return ok({ paymentMethod, pagos, debug });
  } catch (err) {
    console.error('[stripe-billing-info]', err);
    return serverError(err instanceof Error ? err.message : 'Error inesperado');
  }
};
