import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { lecturaStripe, reconciliarStripe } from '../_lib/reconciliacionStripe';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * Cron (diario, 09:00 UTC): reconciliación Stripe DETECT-ONLY (PKG-03B, EKKO-140,
 * D-03B-1 = A). Envoltorio delgado sobre el MISMO núcleo que el endpoint manual
 * `reconciliar-stripe`: lee Stripe (solo `accounts.retrieve` y
 * `subscriptions.list`), compara con lo que EKKO espera y asienta la evidencia en
 * `reconciliacion_stripe_corridas` / `discrepancias_stripe`. No repara nada: ni
 * pausa, ni reanuda, ni cancela, ni toca membresías. Lo programa Netlify
 * (netlify.toml); la plataforma no lo expone por HTTP público, así que no lleva
 * token (el manual sí). Una corrida parcial o fallida queda visible en Operación.
 */
export const handler: Handler = async () => {
  if (!process.env.STRIPE_SECRET_KEY) return ok({ skipped: 'stripe_no_configurado' });
  try {
    const admin = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });
    const r = await reconciliarStripe(admin, lecturaStripe(getStripe()));
    const noCompletas = r.estudios.filter((e) => e.estado !== 'completa');
    console.log('[cron-reconciliar-stripe] OK', JSON.stringify({ corrida_id: r.corrida_id, estudios: r.estudios.length, no_completas: noCompletas.length }));
    return ok(r);
  } catch (e) {
    await reportarErrorServidor('cron-reconciliar-stripe', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
