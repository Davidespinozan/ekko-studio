import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import { timingSafeEqual } from 'node:crypto';
import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, forbidden, serverError } from '../_lib/http';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { lecturaStripe, reconciliarStripe } from '../_lib/reconciliacionStripe';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /reconciliar-stripe — PKG-03B, corrida MANUAL del reconciliador
 * detect-only (D-03B-1 = A). Lee Stripe (solo lectura) y asienta discrepancias.
 *
 * Deshabilitada por defecto: sin `RECONCILIAR_STRIPE_TOKEN` configurado responde
 * 403 siempre. Con él, exige `Authorization: Bearer <token>`. La primera corrida
 * en producción requiere autorización explícita; el horario diario
 * (`cron-reconciliar-stripe` + `schedule` en netlify.toml) es un paso posterior.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  const token = optionalEnv('RECONCILIAR_STRIPE_TOKEN');
  if (!token) return forbidden('Reconciliación deshabilitada');
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const dado = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const a = Buffer.from(dado);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return forbidden('No autorizado');

  if (!process.env.STRIPE_SECRET_KEY) return serverError('Stripe no configurado');
  try {
    const admin = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });
    const r = await reconciliarStripe(admin, lecturaStripe(getStripe()));
    console.log('[reconciliar-stripe]', JSON.stringify(r));
    return ok(r);
  } catch (e) {
    await reportarErrorServidor('reconciliar-stripe', e);
    return serverError('No se pudo completar la reconciliación');
  }
};
