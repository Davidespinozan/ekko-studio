import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * Cron diario: avisa al miembro que su paquete/plan está por vencer.
 *
 * Nadie le avisaba: el miembro descubría que su paquete caducó cuando ya no
 * podía reservar. En EKKO las mensuales de Stripe se renuevan solas, así que la
 * RPC `avisar_membresias_por_vencer` solo avisa cuando hay que actuar
 * (paquetes con caducidad, membresías de mostrador, cancelaciones al fin del
 * periodo), una vez por periodo. Aquí se manda el push por cada aviso.
 *
 * Programado en netlify.toml como [functions."cron-membresias-por-vencer"] schedule "0 15 * * *"
 * (15:00 UTC ≈ 8:00 en Culiacán). Portado de SALA.
 */
const DIAS_DE_AVISO = 3;

export const handler: Handler = async () => {
  try {
    const supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('avisar_membresias_por_vencer', { p_dias: DIAS_DE_AVISO });
    if (error) {
      await reportarErrorServidor('cron-membresias-por-vencer', new Error(error.message), { rpc: 'avisar_membresias_por_vencer' });
      return serverError(error.message);
    }

    // El push lo reparte cron-push (cada minuto) a partir de las filas que dejó la
    // RPC en `notificaciones` (push_enviado_at IS NULL): un solo repartidor.
    const filas = (data ?? []) as Array<{ usuario_id: string }>;
    const pushEnviados = 0;

    console.log('[cron-membresias-por-vencer] OK', { avisados: filas.length, pushEnviados });
    return ok({ avisados: filas.length, pushEnviados });
  } catch (e) {
    await reportarErrorServidor('cron-membresias-por-vencer', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
