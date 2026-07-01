import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { optionalEnv } from './env';

/**
 * Entrega de Web Push. Un solo helper que usan todas las funciones que insertan
 * en `notificaciones`: tras crear el aviso in-app, llaman a `enviarPushAUsuario`
 * para que llegue al teléfono aunque la app esté cerrada. Patrón de HSC.
 *
 * Sin VAPID configurado (VAPID_PUBLIC_KEY/PRIVATE_KEY) es un no-op silencioso:
 * no rompe el flujo principal (el aviso in-app ya se guardó).
 */

export interface PushPayload {
  titulo: string;
  mensaje: string;
  /** Deep-link a abrir al tocar la notificación (default '/app'). */
  url?: string;
  /** Agrupa/reemplaza notificaciones del mismo tipo. */
  tag?: string;
}

let configurado = false;
function configurar(): boolean {
  if (configurado) return true;
  const publicKey = optionalEnv('VAPID_PUBLIC_KEY');
  const privateKey = optionalEnv('VAPID_PRIVATE_KEY');
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    optionalEnv('VAPID_SUBJECT', 'mailto:soporte@ekko.studio'),
    publicKey,
    privateKey
  );
  configurado = true;
  return true;
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Envía un push a TODOS los dispositivos suscritos de un usuario. Borra las
 * suscripciones muertas (404/410). No lanza: un fallo de push no debe romper la
 * operación principal (el aviso in-app ya existe).
 *
 * Devuelve un resumen (útil para el cron / tests).
 */
export async function enviarPushAUsuario(
  admin: SupabaseClient,
  usuarioId: string,
  payload: PushPayload
): Promise<{ enviados: number; borrados: number; sinConfig?: boolean }> {
  if (!configurar()) return { enviados: 0, borrados: 0, sinConfig: true };

  const { data: subs, error } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('usuario_id', usuarioId);
  if (error || !subs || subs.length === 0) return { enviados: 0, borrados: 0 };

  const body = JSON.stringify({
    title: payload.titulo,
    body: payload.mensaje,
    url: payload.url ?? '/app',
    tag: payload.tag
  });

  let enviados = 0;
  const muertos: string[] = [];

  await Promise.all(
    (subs as SubRow[]).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body
        );
        enviados++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          muertos.push(s.id); // suscripción caduca → limpiar
        } else {
          console.error('[push] envío falló', status, err);
        }
      }
    })
  );

  if (muertos.length > 0) {
    await admin.from('push_subscriptions').delete().in('id', muertos);
  }

  return { enviados, borrados: muertos.length };
}
