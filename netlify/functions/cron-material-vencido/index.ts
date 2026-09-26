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
 * Cron (diario): borra de Storage los ARCHIVOS de material cuya vigencia terminó
 * hace más de 7 días (`material_vencido_por_borrar` los devuelve y los marca). El
 * miembro deja de verlos y de poder descargarlos en el instante en que vencen —
 * eso lo hacen cumplir RLS y la policy de Storage, no este cron—; esto solo libera
 * el espacio, que en video es lo que cuesta.
 *
 * Los enlaces externos no ocupan nada aquí: no se tocan.
 */
export const handler: Handler = async () => {
  try {
    const supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('material_vencido_por_borrar', { p_limite: 200 });
    if (error) {
      await reportarErrorServidor('cron-material-vencido', new Error(error.message), { paso: 'rpc' });
      return serverError(error.message);
    }

    const rutas = ((data ?? []) as Array<{ storage_path: string | null }>)
      .map((f) => f.storage_path)
      .filter((r): r is string => !!r);
    if (rutas.length === 0) return ok({ borrados: 0 });

    const { error: rmErr } = await supabase.storage.from('material').remove(rutas);
    if (rmErr) {
      // Las filas ya quedaron marcadas: el miembro no las ve. Queda espacio sin
      // liberar → se reporta con las rutas para borrarlas a mano.
      await reportarErrorServidor('cron-material-vencido', new Error(rmErr.message), { paso: 'storage.remove', rutas });
      return serverError(rmErr.message);
    }

    console.log('[cron-material-vencido] OK', { borrados: rutas.length });
    return ok({ borrados: rutas.length });
  } catch (e) {
    await reportarErrorServidor('cron-material-vencido', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
