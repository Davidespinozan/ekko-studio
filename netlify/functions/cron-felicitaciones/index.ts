import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { enviarPushAUsuario } from '../_lib/push';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * Cron diario: felicita por cumpleaños (in-app + push). Usa la fecha de
 * nacimiento de la ficha de identidad (obligatoria para el check-in, así que la
 * cobertura es casi total). La RPC es idempotente por día.
 *
 * Programado en netlify.toml como [functions."cron-felicitaciones"] schedule "0 16 * * *"
 * (16:00 UTC ≈ 9:00 en Culiacán). Portado de SALA (b0ba8e4).
 */
export const handler: Handler = async () => {
  try {
    const supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('generar_felicitaciones_cumpleanos');
    if (error) {
      await reportarErrorServidor('cron-felicitaciones', new Error(error.message), { rpc: 'generar_felicitaciones_cumpleanos' });
      return serverError(error.message);
    }

    const filas = (data ?? []) as Array<{ usuario_id: string; titulo: string; mensaje: string }>;
    let pushEnviados = 0;
    for (const f of filas) {
      const r = await enviarPushAUsuario(supabase, f.usuario_id, {
        titulo: f.titulo,
        mensaje: f.mensaje,
        url: '/app',
        tag: 'cumpleanos'
      });
      pushEnviados += r.enviados;
    }

    console.log('[cron-felicitaciones] OK', { felicitados: filas.length, pushEnviados });
    return ok({ felicitados: filas.length, pushEnviados });
  } catch (e) {
    await reportarErrorServidor('cron-felicitaciones', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
