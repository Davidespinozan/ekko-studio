import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { reportarErrorServidor } from '../_lib/sentry';
import { registrarEjecucion } from '../_lib/procesos';

/**
 * Cron: recuerda a los miembros su reserva próxima (~1 hora antes).
 *
 * Programado en netlify.toml como [functions."cron-recordatorios"] schedule cada 15 minutos.
 * Llama al RPC `generar_recordatorios_reservas`, que inserta la
 * notificación in-app (con dedupe por reserva) y devuelve las filas nuevas;
 * por cada una se dispara el push. Service_role: opera sin sesión, cross-tenant.
 */
export const handler: Handler = async () => {
  let supabase: SupabaseClient | null = null;
  try {
    supabase = createClient(
      requireEnv('VITE_SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } }
    );

    const { data, error } = await supabase.rpc('generar_recordatorios_reservas');
    if (error) {
      await reportarErrorServidor('cron-recordatorios', new Error(error.message), { rpc: 'generar_recordatorios_reservas' });
      await registrarEjecucion(supabase, 'cron-recordatorios', 'fallo', 'base_datos');
      return serverError(error.message);
    }

    const filas = (data ?? []) as Array<{
      usuario_id: string;
      titulo: string;
      mensaje: string;
      reserva_id: string;
    }>;

    // El push lo reparte cron-push (cada minuto) a partir de las filas que dejó
    // la RPC en `notificaciones` (push_enviado_at IS NULL).
    const pushEnviados = 0;

    console.log('[cron-recordatorios] OK', { recordatorios: filas.length, pushEnviados });
    await registrarEjecucion(supabase, 'cron-recordatorios', 'exito');
    return ok({ recordatorios: filas.length, pushEnviados });
  } catch (e) {
    await reportarErrorServidor('cron-recordatorios', e);
    await registrarEjecucion(supabase, 'cron-recordatorios', 'fallo', 'interno');
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
