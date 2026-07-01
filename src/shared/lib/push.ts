import { supabase } from './supabase';

/**
 * Web Push del lado del cliente: pedir permiso, suscribirse con la VAPID public
 * y guardar la suscripción en `push_subscriptions`. El envío lo hace el backend
 * (`_lib/push.ts`). Patrón de HSC.
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export type EstadoPush = 'no-soportado' | 'necesita-instalar' | 'denegado' | 'activo' | 'inactivo';

export function pushSoportado(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function esIOS(): boolean {
  if (typeof window === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !(window as unknown as { MSStream?: unknown }).MSStream;
}

export function esStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** iOS solo permite push si la PWA está instalada (Agregar a inicio). */
export function necesitaInstalar(): boolean {
  return esIOS() && !esStandalone();
}

/** La VAPID public (base64url) debe ir como Uint8Array a applicationServerKey. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Estado actual: soporte, permiso y si ya hay suscripción. */
export async function estadoPush(): Promise<EstadoPush> {
  if (!pushSoportado()) return 'no-soportado';
  if (necesitaInstalar()) return 'necesita-instalar';
  if (Notification.permission === 'denied') return 'denegado';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'activo' : 'inactivo';
  } catch {
    return 'inactivo';
  }
}

/**
 * Pide permiso, se suscribe y guarda la suscripción. Debe llamarse desde un
 * gesto del usuario (click). Devuelve el estado resultante.
 */
export async function activarPush(usuario: { id: string; tenant_id: string }): Promise<EstadoPush> {
  if (!pushSoportado()) return 'no-soportado';
  if (necesitaInstalar()) return 'necesita-instalar';
  if (!VAPID_PUBLIC_KEY) throw new Error('Falta configurar las notificaciones (VAPID).');

  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') return permiso === 'denied' ? 'denegado' : 'inactivo';

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource
    });
  }

  const json = sub.toJSON();
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      tenant_id: usuario.tenant_id,
      usuario_id: usuario.id,
      endpoint: json.endpoint ?? '',
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
      user_agent: navigator.userAgent
    },
    { onConflict: 'endpoint' }
  );
  if (error) throw new Error(error.message);
  return 'activo';
}

/** Se desuscribe del navegador y borra la fila. */
export async function desactivarPush(): Promise<EstadoPush> {
  if (!pushSoportado()) return 'no-soportado';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    }
  } catch {
    // best-effort
  }
  return 'inactivo';
}
