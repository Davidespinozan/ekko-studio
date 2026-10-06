import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { enviarPushAUsuario, clasificarPush, registrarResultadoPush, type ResultadoPush } from '../_lib/push';
import { reportarErrorServidor } from '../_lib/sentry';
import { registrarEjecucion } from '../_lib/procesos';

/**
 * Cron (cada minuto): reparte por push TODA notificación pendiente
 * (`push_enviado_at IS NULL`), venga de donde venga — RPCs de la base
 * (cancelaciones, no-show, avisos por vencer, cumpleaños, clave temporal) o
 * functions. Antes el push estaba cableado disparador por disparador y la
 * mitad de los avisos no llegaba al teléfono. (SALA aa4a34d.)
 *
 * Solo mira las últimas 24 h (lo más viejo ya no es "aviso"), en lotes de 200.
 *
 * PKG-03A · resultado honesto: la base reclama las filas con un lease
 * (`reclamar_push_pendientes`: dos corridas o un envío directo no duplican) y,
 * DESPUÉS de intentar, se asienta `push_resultado` (enviado | sin_suscripcion |
 * fallo | sin_config). `push_enviado_at` solo existe si de verdad salió. Sin
 * reintento de push: un fallo queda escrito, no se repite para siempre.
 *
 * Programado en netlify.toml como [functions."cron-push"] schedule "* * * * *".
 */
const URL_POR_TIPO: Record<string, string> = {
  reserva_cancelada: '/app/reservas',
  recordatorio_reserva: '/app/reservas',
  no_show: '/app/reservas',
  membresia_por_vencer: '/app/perfil',
  membresia_pausada: '/app/perfil',
  membresia_reactivada: '/app/perfil',
  cambiar_password: '/app/perfil',
  cobro_rechazado: '/admin/miembros',
  reembolso: '/admin/cobros',
  disputa: '/admin/cobros',
  stripe_desconectado: '/admin/cobros'
};

export const handler: Handler = async () => {
  let supabase: SupabaseClient | null = null;
  try {
    supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('reclamar_push_pendientes', { p_limite: 200 });
    if (error) {
      await reportarErrorServidor('cron-push', new Error(error.message), { paso: 'select' });
      await registrarEjecucion(supabase, 'cron-push', 'fallo', 'base_datos');
      return serverError(error.message);
    }

    const filas = (data ?? []) as Array<{ id: string; usuario_id: string; tipo: string; titulo: string; mensaje: string; metadata: Record<string, unknown> | null }>;
    let enviados = 0;
    for (const n of filas) {
      let resultado: ResultadoPush;
      try {
        const r = await enviarPushAUsuario(supabase, n.usuario_id, {
          titulo: n.titulo,
          mensaje: n.mensaje,
          url: (typeof n.metadata?.url === 'string' && n.metadata.url) || URL_POR_TIPO[n.tipo] || '/app',
          tag: n.tipo
        });
        enviados += r.enviados;
        resultado = clasificarPush(r);
      } catch (e) {
        await reportarErrorServidor('cron-push', e, { notificacion_id: n.id, tipo: n.tipo });
        resultado = 'fallo';
      }
      await registrarResultadoPush(supabase, [n.id], resultado);
    }

    if (filas.length) console.log('[cron-push] OK', { pendientes: filas.length, pushEnviados: enviados });
    // La corrida terminó: cada aviso quedó con su resultado (los no entregados los
    // muestra Operación agregados; no son un fallo del proceso).
    await registrarEjecucion(supabase, 'cron-push', 'exito');
    return ok({ pendientes: filas.length, pushEnviados: enviados });
  } catch (e) {
    await reportarErrorServidor('cron-push', e);
    await registrarEjecucion(supabase, 'cron-push', 'fallo', 'interno');
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
