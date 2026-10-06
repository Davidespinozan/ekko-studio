import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ok } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { reportarErrorServidor } from '../_lib/sentry';
import { registrarEjecucion } from '../_lib/procesos';

/**
 * Cron (diario): libera de Storage el material que el NEGOCIO ya retiró.
 *
 *  1. `material_vencido_por_borrar` marca los ARCHIVOS vencidos hace más de 7 días
 *     (igual que antes). El miembro dejó de verlos y de poder descargarlos en el
 *     instante en que vencieron — eso lo hacen cumplir RLS y la policy de Storage,
 *     no este cron.
 *  2. PKG-06E (FR-43/44): `material_limpieza_pendiente` devuelve TODO lo retirado
 *     (vencido o retirado por el staff) cuyo objeto SIGUE en Storage, con la ruta
 *     que dice la base. Si un borrado anterior falló — aquí o en el navegador del
 *     staff — vuelve a aparecer y se reintenta; "ya no estaba" no aparece: converge.
 *  3. Se borra por tandas. Cualquier tanda fallida o con resultado desconocido deja
 *     esos objetos pendientes para la siguiente corrida y el proceso queda en
 *     `fallo`/`parcial` (06G). Si en 2 días no converge, Operación lo muestra.
 *
 * Los enlaces externos no ocupan nada aquí: no se tocan. Los objetos SIN fila
 * (huérfanos) nunca se borran desde aquí.
 */

export const TANDA = 100;
const LIMITE = 200;

export const handler: Handler = async () => {
  let supabase: SupabaseClient | null = null;
  try {
    supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const marcado = await supabase.rpc('material_vencido_por_borrar', { p_limite: LIMITE });
    if (marcado.error) {
      await reportarErrorServidor('cron-material-vencido', new Error(marcado.error.message), { paso: 'rpc_vencidos' });
      await registrarEjecucion(supabase, 'cron-material-vencido', 'fallo', 'base_datos');
      return { statusCode: 500, body: JSON.stringify({ error: 'base_datos' }) };
    }
    const vencidos = ((marcado.data ?? []) as unknown[]).length;

    const pend = await supabase.rpc('material_limpieza_pendiente', { p_limite: LIMITE });
    if (pend.error) {
      await reportarErrorServidor('cron-material-vencido', new Error(pend.error.message), { paso: 'rpc_limpieza' });
      await registrarEjecucion(supabase, 'cron-material-vencido', 'fallo', 'base_datos');
      return { statusCode: 500, body: JSON.stringify({ error: 'base_datos', vencidos }) };
    }
    const rutas = [
      ...new Set(
        ((pend.data ?? []) as Array<{ storage_path: string | null }>)
          .map((f) => f.storage_path)
          .filter((r): r is string => typeof r === 'string' && r.length > 0)
      )
    ];
    if (rutas.length === 0) {
      await registrarEjecucion(supabase, 'cron-material-vencido', 'exito');
      return ok({ vencidos, borrados: 0, pendientes: 0 });
    }

    let borrados = 0;
    let tandasFallidas = 0;
    for (let i = 0; i < rutas.length; i += TANDA) {
      const tanda = rutas.slice(i, i + TANDA);
      try {
        const { error } = await supabase.storage.from('material').remove(tanda);
        if (error) {
          tandasFallidas++;
          await reportarErrorServidor('cron-material-vencido', new Error(error.message), { paso: 'storage.remove', clase: 'storage_remove_failed', objetos: tanda.length });
        } else {
          // Sin error: los que estaban se borraron y los que ya no estaban convergen.
          borrados += tanda.length;
        }
      } catch (e) {
        // Timeout / red: resultado desconocido. La siguiente corrida vuelve a mirar
        // Storage y solo reintenta lo que siga ahí.
        tandasFallidas++;
        await reportarErrorServidor('cron-material-vencido', e, { paso: 'storage.remove', clase: 'storage_result_unknown', objetos: tanda.length });
      }
    }

    const pendientes = rutas.length - borrados;
    if (tandasFallidas > 0) {
      await registrarEjecucion(supabase, 'cron-material-vencido', borrados > 0 ? 'parcial' : 'fallo', 'almacenamiento');
      return { statusCode: 500, body: JSON.stringify({ error: 'almacenamiento', vencidos, borrados, pendientes }) };
    }
    console.log('[cron-material-vencido] OK', { vencidos, borrados });
    await registrarEjecucion(supabase, 'cron-material-vencido', 'exito');
    return ok({ vencidos, borrados, pendientes: 0 });
  } catch (e) {
    await reportarErrorServidor('cron-material-vencido', e);
    await registrarEjecucion(supabase, 'cron-material-vencido', 'fallo', 'interno');
    return { statusCode: 500, body: JSON.stringify({ error: 'interno' }) };
  }
};
