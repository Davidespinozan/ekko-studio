# Notificaciones Push (Web Push / PWA)

Entrega de avisos **fuera de la app** (aunque esté cerrada), sobre las
notificaciones IN-APP que EKKO ya tenía (tabla `notificaciones`). Patrón tomado
de HSC. El **código está implementado**; faltan las VAPID keys (pasos de David).

## Cómo funciona

- **Suscripción**: el miembro toca "Activar" en Perfil → el navegador pide
  permiso → se guarda su dispositivo en `push_subscriptions` (una fila por
  dispositivo, `UNIQUE(endpoint)`).
- **Entrega**: cuando se crea un aviso in-app, el backend llama a
  `enviarPushAUsuario` (`netlify/functions/_lib/push.ts`, paquete `web-push`),
  que manda push a todos los dispositivos del usuario y **borra los muertos**
  (404/410).
- **Service worker**: `public/push-sw.js` (handlers `push`/`notificationclick`)
  se inyecta en el SW de Workbox vía `workbox.importScripts` (sin un 2º SW).

### Qué dispara push hoy (disparo desde Node)
- **Aviso manual de recepción** (`reception-notificar-miembro`).
- **Recurso fuera de servicio** → reservas canceladas (`reception-recurso-servicio`).
- **Recordatorio de reserva ~1h antes**: cron `cron-recordatorios` (cada 15 min)
  → RPC `generar_recordatorios_reservas` (inserta la notif con dedupe por
  `reservas.recordatorio_enviado_at`) → push por cada fila nueva.

> Pendiente conocido: la cancelación iniciada por el **miembro** o desde el modal
> de recepción pasa por una RPC llamada del lado del cliente, no por Node, así
> que ese caso no dispara push todavía. (El miembro que se auto-cancela no lo
> necesita.) Para cubrir TODO desde un solo punto en el futuro: trigger
> `AFTER INSERT ON notificaciones` + `pg_net` → una función `push-send`.

## Los pasos que faltan (tu lado)

### 1. Generar las VAPID keys
```
npx web-push generate-vapid-keys
```
Da un par `Public Key` / `Private Key`.

### 2. Env vars en Netlify
```
VAPID_PUBLIC_KEY=<public>
VAPID_PRIVATE_KEY=<private>          # secreta — solo backend
VAPID_SUBJECT=mailto:soporte@tu-dominio.com
VITE_VAPID_PUBLIC_KEY=<public>       # la MISMA public, para el cliente
```
Sin estas, todo es no-op silencioso (los avisos in-app siguen funcionando).

### 3. Aplicar las migraciones al Supabase de EKKO
- `20260620130000_push_subscriptions.sql`
- `20260620140000_recordatorios_reservas.sql`

## Probar
1. Con las env vars puestas y la PWA **instalada** (en iOS es obligatorio):
   Perfil → "Avisos en el teléfono" → Activar → aceptar el permiso.
2. Recepción manda un aviso manual → debería llegar la notificación al teléfono.
3. El recordatorio llega solo ~1h antes de una reserva confirmada.

## Gotchas
- **iOS 16.4+**: push solo si la PWA está **instalada** (Agregar a inicio) — por
  eso el `PwaInstallBanner`. El permiso debe pedirse con un gesto (el botón).
- **Permiso denegado es sticky**: hay que rehabilitarlo en ajustes del navegador.
- **VAPID**: la public va al cliente y al server; la private es secreta. Deben ser
  el mismo par o el push falla. No rotar sin re-suscribir a todos.
- **Suscripciones muertas**: se borran solas al primer 404/410 en el envío.
