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
 * Cron (cada minuto): reparte por push TODA notificación pendiente
 * (`push_enviado_at IS NULL`), venga de donde venga — RPCs de la base
 * (cancelaciones, no-show, avisos por vencer, cumpleaños, clave temporal) o
 * functions. Antes el push estaba cableado disparador por disparador y la
 * mitad de los avisos no llegaba al teléfono. (SALA aa4a34d.)
 *
 * Solo mira las últimas 24 h (lo más viejo ya no es "aviso"), en lotes de 200,
 * y marca cada fila aunque el push falle o el usuario no tenga suscripción: la
 * notificación in-app sigue existiendo; lo que no debe pasar es reintentar
 * para siempre.
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
  try {
    const supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data, error } = await supabase
      .from('notificaciones')
      .select('id, usuario_id, tipo, titulo, mensaje, metadata')
      .is('push_enviado_at', null)
      .gte('creada_at', desde)
      .order('creada_at', { ascending: true })
      .limit(200);
    if (error) {
      await reportarErrorServidor('cron-push', new Error(error.message), { paso: 'select' });
      return serverError(error.message);
    }

    const filas = (data ?? []) as Array<{ id: string; usuario_id: string; tipo: string; titulo: string; mensaje: string; metadata: Record<string, unknown> | null }>;
    let enviados = 0;
    for (const n of filas) {
      try {
        const r = await enviarPushAUsuario(supabase, n.usuario_id, {
          titulo: n.titulo,
          mensaje: n.mensaje,
          url: (typeof n.metadata?.url === 'string' && n.metadata.url) || URL_POR_TIPO[n.tipo] || '/app',
          tag: n.tipo
        });
        enviados += r.enviados;
      } catch (e) {
        await reportarErrorServidor('cron-push', e, { notificacion_id: n.id, tipo: n.tipo });
      } finally {
        await supabase.from('notificaciones').update({ push_enviado_at: new Date().toISOString() }).eq('id', n.id);
      }
    }

    if (filas.length) console.log('[cron-push] OK', { pendientes: filas.length, pushEnviados: enviados });
    return ok({ pendientes: filas.length, pushEnviados: enviados });
  } catch (e) {
    await reportarErrorServidor('cron-push', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
