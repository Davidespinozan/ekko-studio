import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';

/**
 * Cron: a diario, marca `expirada` las membresías de paquete (no-Stripe) cuyo
 * periodo ya pasó, para que los dashboards reflejen la realidad (antes el
 * vencimiento era lazy, solo al reservar).
 *
 * Además RECONCILIA con Stripe (#8 del audit): cancela en Stripe la suscripción
 * de cualquier membresía dada de baja recientemente cuya sub siga viva — así se
 * cubren TODAS las vías de quitar plan (admin/recepción/trigger), no solo el
 * auto-cancel del miembro. Guarda: NUNCA toca una sub aún ligada a una membresía
 * viva.
 *
 * Programado en netlify.toml como [[scheduled_functions]] con cron "0 7 * * *"
 * (7:00 UTC ≈ medianoche en Culiacán). service_role: opera cross-tenant sin sesión.
 */
export const handler: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('expirar_membresias_vencidas');

    if (error) {
      console.error('[cron-expirar-membresias]', error);
      return serverError(error.message);
    }

    const subsCanceladas = await reconciliarSubsHuerfanas(supabase);

    console.log('[cron-expirar-membresias] OK', { expiradas: data, subsCanceladas });
    return ok({ expiradas: data, subsCanceladas });
  } catch (e) {
    console.error('[cron-expirar-membresias] Error', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

/**
 * Cancela en Stripe las suscripciones de membresías dadas de baja (cancelada/
 * expirada) en las últimas 48 h cuya sub siga viva. No-op sin Stripe configurado.
 */
async function reconciliarSubsHuerfanas(supabase: any): Promise<number> {
  if (!process.env.STRIPE_SECRET_KEY) return 0;

  const desde = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('membresias')
    .select('tenant_id, stripe_subscription_id')
    .in('status', ['cancelada', 'expirada'])
    .not('stripe_subscription_id', 'is', null)
    .gte('updated_at', desde);

  const filas = (data ?? []) as Array<{ tenant_id: string; stripe_subscription_id: string }>;
  if (filas.length === 0) return 0;

  const stripe = getStripe();
  const cuentaPorTenant = new Map<string, string | null>();
  let canceladas = 0;

  for (const m of filas) {
    // Guarda: si esa sub sigue ligada a una membresía VIVA, no tocarla.
    const { data: viva } = await supabase
      .from('membresias')
      .select('id')
      .eq('stripe_subscription_id', m.stripe_subscription_id)
      .in('status', ['trialing', 'activa', 'past_due'])
      .limit(1);
    if (viva && viva.length > 0) continue;

    let accountId = cuentaPorTenant.get(m.tenant_id);
    if (accountId === undefined) {
      accountId = (await resolverCuentaConectada(supabase, m.tenant_id)).accountId;
      cuentaPorTenant.set(m.tenant_id, accountId);
    }
    if (!accountId) continue;

    try {
      const sub = await stripe.subscriptions.retrieve(m.stripe_subscription_id, { stripeAccount: accountId });
      if (['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) {
        await stripe.subscriptions.cancel(m.stripe_subscription_id, { stripeAccount: accountId });
        canceladas++;
      }
    } catch (e) {
      console.error('[cron-expirar-membresias] reconciliar sub', m.stripe_subscription_id, e instanceof Error ? e.message : e);
    }
  }

  return canceladas;
}
