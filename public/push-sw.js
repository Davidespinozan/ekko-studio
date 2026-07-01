/* eslint-disable */
/*
 * Handlers de Web Push para EKKO. Se inyecta DENTRO del service worker de
 * Workbox (vite-plugin-pwa) vía workbox.importScripts, así conviven el caché de
 * la PWA y el push sin un segundo SW. Patrón de HSC.
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = { title: 'EKKO', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'EKKO';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || undefined,
    data: { url: payload.url || '/app' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Si ya hay una ventana de la app abierta, la enfocamos y navegamos.
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url).catch(() => {});
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
