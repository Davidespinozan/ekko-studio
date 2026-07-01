import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Helpers de Stripe Connect (direct charges): el estudio es una cuenta conectada
 * bajo la plataforma STRYV y cobra directo a sus miembros. Todo lo de cobro vive
 * sobre `stripeAccount`. Patrón portado de SALA. El `stripe_customer_id` del
 * miembro es POR cuenta conectada → se guarda en `usuarios_datos_privados`.
 */

export interface CuentaConectada {
  accountId: string | null;
  chargesEnabled: boolean;
}

export async function resolverCuentaConectada(
  admin: SupabaseClient,
  tenantId: string
): Promise<CuentaConectada> {
  const { data } = await admin
    .from('tenants')
    .select('stripe_account_id, stripe_charges_enabled')
    .eq('id', tenantId)
    .maybeSingle();
  return {
    accountId: data?.stripe_account_id ?? null,
    chargesEnabled: data?.stripe_charges_enabled === true
  };
}

/**
 * Customer del miembro EN la cuenta conectada (direct charges). Reusa el guardado
 * en `usuarios_datos_privados`; si no, matchea por metadata (app+usuario_id, no
 * email) y si tampoco, lo crea con idempotencyKey.
 */
export async function getOrCreateSocioCustomer(
  stripe: Stripe,
  admin: SupabaseClient,
  socio: { id: string; tenant_id: string; email: string | null },
  stripeAccount: string
): Promise<string> {
  const { data: dp } = await admin
    .from('usuarios_datos_privados')
    .select('stripe_customer_id')
    .eq('usuario_id', socio.id)
    .maybeSingle();
  if (dp?.stripe_customer_id) return dp.stripe_customer_id;

  const persist = async (customerId: string) => {
    await admin
      .from('usuarios_datos_privados')
      .upsert(
        { usuario_id: socio.id, tenant_id: socio.tenant_id, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
        { onConflict: 'usuario_id' }
      );
  };

  if (socio.email) {
    try {
      const found = await stripe.customers.list({ email: socio.email, limit: 100 }, { stripeAccount });
      const match = found.data.find(
        (c) => c.metadata?.app === 'ekko' && c.metadata?.usuario_id === socio.id
      );
      if (match) {
        await persist(match.id);
        return match.id;
      }
    } catch {
      // customers.list puede fallar en cuentas nuevas → seguimos y creamos.
    }
  }

  const customer = await stripe.customers.create(
    {
      email: socio.email ?? undefined,
      metadata: { app: 'ekko', usuario_id: socio.id },
      preferred_locales: ['es']
    },
    { idempotencyKey: `ekko_socio_${socio.id}`, stripeAccount }
  );
  await persist(customer.id);
  return customer.id;
}
