import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { resolverCuentaConectada } from '../_lib/connectBilling';
import { reportarErrorServidor, conMonitorCron } from '../_lib/sentry';
import { ejecutarOperacionesSuscripcion, type ResumenOperaciones } from '../_lib/operacionesSuscripcion';

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
 * Programado en netlify.toml como [functions."cron-expirar-membresias"] schedule "0 7 * * *"
 * (7:00 UTC ≈ medianoche en Culiacán). service_role: opera cross-tenant sin sesión.
 *
 * Observabilidad (lección de SALA): los errores se reportan a Sentry (antes solo
 * console.error en logs que nadie lee), el handler va envuelto en un Cron
 * Monitor (si este cron no corre a su hora, Sentry avisa solo) y al final corre
 * `chequeosDeFrescura` sobre los efectos de los OTROS crons.
 */
const CRON_EXPR = '0 7 * * *';

/** Efectos de los otros crons que deberían estar frescos. Solo lee y reporta. */
async function chequeosDeFrescura(supabase: SupabaseClient): Promise<void> {
  // cron-no-shows (cada hora): una reserva confirmada cuya sesión terminó hace
  // >36h ya debería estar completada o no_show.
  const { count: sinProcesar } = await supabase
    .from('reservas')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'confirmada')
    .lt('slot_fin', new Date(Date.now() - 36 * 3600_000).toISOString());
  if ((sinProcesar ?? 0) > 0) {
    await reportarErrorServidor(
      'salud-plataforma',
      new Error(`cron-no-shows atrasado: ${sinProcesar} reservas pasadas siguen 'confirmada' tras 36h`),
      { chequeo: 'reservas_sin_procesar' }
    );
  }

  // Este mismo cron (diario): un paquete sin Stripe con periodo vencido hace >48h
  // que siga 'activa' significa que la expiración no está corriendo bien.
  const { count: vencidasActivas } = await supabase
    .from('membresias')
    .select('id', { count: 'exact', head: true })
    .in('status', ['activa', 'trialing'])
    .is('stripe_subscription_id', null)
    .lt('periodo_actual_fin', new Date(Date.now() - 48 * 3600_000).toISOString());
  if ((vencidasActivas ?? 0) > 0) {
    await reportarErrorServidor(
      'salud-plataforma',
      new Error(`expirar_membresias atrasado: ${vencidasActivas} membresías vencidas hace >48h siguen activas`),
      { chequeo: 'membresias_vencidas_activas' }
    );
  }
}

const run: Handler = async () => {
  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('expirar_membresias_vencidas');

    if (error) {
      await reportarErrorServidor('cron-expirar-membresias', new Error(error.message), { rpc: 'expirar_membresias_vencidas' });
      return serverError(error.message);
    }

    const subsCanceladas = await reconciliarSubsHuerfanas(supabase);

    // R2-B (PKG-01P): reintenta las operaciones de cobro pendientes o fallidas
    // (suspender / reanudar / cancelar) sin ventana de tiempo: mientras la fila
    // siga sin aplicarse, se vuelve a intentar cada día.
    let operacionesCobro: ResumenOperaciones | null = null;
    try {
      operacionesCobro = await ejecutarOperacionesSuscripcion(supabase, { limite: 50 });
    } catch (e) {
      await reportarErrorServidor('cron-expirar-membresias', e, { paso: 'operaciones_suscripcion' });
    }

    // Salud del resto de la plataforma (nunca tira el cron principal).
    try {
      await chequeosDeFrescura(supabase);
    } catch (e) {
      await reportarErrorServidor('salud-plataforma', e, { chequeo: 'chequeos_de_frescura' });
    }

    console.log('[cron-expirar-membresias] OK', { expiradas: data, subsCanceladas, operacionesCobro });
    return ok({ expiradas: data, subsCanceladas, operacionesCobro });
  } catch (e) {
    await reportarErrorServidor('cron-expirar-membresias', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};

export const handler: Handler = conMonitorCron('cron-expirar-membresias', CRON_EXPR, run);

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
      await reportarErrorServidor('cron-expirar-membresias', e, { paso: 'reconciliar_sub', sub: m.stripe_subscription_id });
    }
  }

  return canceladas;
}
