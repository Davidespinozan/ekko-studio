import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { llaveCustomer, PresupuestoAgotado, type Presupuesto } from './operacionPago';

/**
 * Helpers de Stripe Connect (direct charges): el estudio es una cuenta conectada
 * bajo la plataforma STRYV y cobra directo a sus miembros. Todo lo de cobro vive
 * sobre `stripeAccount`. Patrón portado de SALA. El `stripe_customer_id` del
 * miembro es POR cuenta conectada → se guarda en `usuarios_datos_privados`.
 */

export interface CuentaConectada {
  accountId: string | null;
  chargesEnabled: boolean;
  /** PKG-01G: el estudio desautorizó la plataforma (account.application.deauthorized). */
  desconectada: boolean;
}

/**
 * Gate de cobro del estudio. PKG-01G (D-01G-3): una cuenta desautorizada
 * conserva `stripe_account_id` (trazabilidad) pero NO puede cobrar aunque el
 * flag `stripe_charges_enabled` quedara desactualizado.
 */
export async function resolverCuentaConectada(
  admin: SupabaseClient,
  tenantId: string
): Promise<CuentaConectada> {
  const { data } = await admin
    .from('tenants')
    .select('stripe_account_id, stripe_charges_enabled, stripe_desconectado_at')
    .eq('id', tenantId)
    .maybeSingle();
  const desconectada = Boolean(data?.stripe_desconectado_at);
  return {
    accountId: data?.stripe_account_id ?? null,
    chargesEnabled: data?.stripe_charges_enabled === true && !desconectada,
    desconectada
  };
}

/**
 * Customer del miembro EN la cuenta conectada (direct charges). Reusa el guardado
 * en `usuarios_datos_privados`; si no, matchea por metadata (app+usuario_id, no
 * email) y si tampoco, lo crea con idempotencyKey.
 *
 * PKG-01C: la key incluye la cuenta conectada (`ekko:v1:cus:<acct>:<usuario>`) y
 * el resultado del upsert se comprueba (antes se ignoraba en silencio). Con
 * `presupuesto`, las llamadas a Stripe respetan el presupuesto interno y el create
 * no lleva reintentos del SDK (el reintento es de la operación completa). Esto NO
 * resuelve C24 (customer borrado, id no ligado a la cuenta, duplicados históricos).
 */
export async function getOrCreateSocioCustomer(
  stripe: Stripe,
  admin: SupabaseClient,
  socio: { id: string; tenant_id: string; email: string | null },
  stripeAccount: string,
  opciones: { presupuesto?: Presupuesto } = {}
): Promise<string> {
  const { presupuesto } = opciones;
  const { data: dp } = await admin
    .from('usuarios_datos_privados')
    .select('stripe_customer_id')
    .eq('usuario_id', socio.id)
    .maybeSingle();
  if (dp?.stripe_customer_id) return dp.stripe_customer_id;

  const persist = async (customerId: string) => {
    const { error } = await admin
      .from('usuarios_datos_privados')
      .upsert(
        { usuario_id: socio.id, tenant_id: socio.tenant_id, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
        { onConflict: 'usuario_id' }
      );
    // No se aborta el cobro (el customer existe y la key estable lo devuelve en el
    // próximo intento), pero el fallo deja rastro en vez de perderse.
    if (error) {
      console.error(JSON.stringify({ evento: 'customer_persist_fallido', usuario_id: socio.id, stripe_account: stripeAccount, codigo: error.code ?? null }));
    }
  };

  if (socio.email) {
    try {
      if (presupuesto && !presupuesto.puedeLeer()) throw new PresupuestoAgotado();
      const found = await stripe.customers.list(
        { email: socio.email, limit: 100 },
        { stripeAccount, ...(presupuesto ? presupuesto.opcionesLectura() : {}) }
      );
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

  if (presupuesto && !presupuesto.puedeMutar()) throw new PresupuestoAgotado();
  const customer = await stripe.customers.create(
    {
      email: socio.email ?? undefined,
      metadata: { app: 'ekko', usuario_id: socio.id },
      preferred_locales: ['es']
    },
    { idempotencyKey: llaveCustomer(stripeAccount, socio.id), stripeAccount, ...(presupuesto ? presupuesto.opcionesMutacion() : {}) }
  );
  await persist(customer.id);
  return customer.id;
}
