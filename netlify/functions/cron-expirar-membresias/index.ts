import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';

/**
 * Cron: a diario, marca `expirada` las membresías de paquete (no-Stripe) cuyo
 * periodo ya pasó, para que los dashboards reflejen la realidad (antes el
 * vencimiento era lazy, solo al reservar).
 *
 * Programado en netlify.toml como [[scheduled_functions]] con cron "0 7 * * *"
 * (7:00 UTC ≈ medianoche en Culiacán). service_role: opera cross-tenant sin
 * sesión. Ver `expirar_membresias_vencidas()`.
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

    console.log('[cron-expirar-membresias] OK', { expiradas: data });
    return ok({ expiradas: data });
  } catch (e) {
    console.error('[cron-expirar-membresias] Error', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
