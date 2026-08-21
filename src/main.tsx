import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from '@shared/components/ErrorBoundary';
import { TenantProvider } from '@shared/providers/TenantProvider';
import { AuthProvider } from '@shared/providers/AuthProvider';
import { initSentry } from '@shared/lib/sentry';
import { intentarAutoRecarga } from '@shared/lib/autoReload';

import './styles/tailwind.css';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/ekko.css';

initSentry();

// PWA auto-update: cuando un service worker NUEVO toma control (tras un deploy),
// recargamos la pestaña para servir la versión nueva sin que el usuario tenga
// que matar el cache a mano. registerType:'autoUpdate' (skipWaiting +
// clientsClaim) activa el SW nuevo solo; esto cierra el último eslabón: recargar
// la pestaña abierta. hadController distingue UPDATE de la 1ª instalación.
// (Portado de SALA bc64a37 / 058cc8b.)
if ('serviceWorker' in navigator) {
  const hadController = navigator.serviceWorker.controller != null;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });

  // Chequeo de update al volver a la pestaña / recuperar el foco, con throttle
  // de 30s, y PERIÓDICO cada 2 min para el iPad de recepción que nunca cambia
  // de pestaña. Si hay SW nuevo: update() lo instala → autoUpdate lo activa →
  // 'controllerchange' recarga.
  let ultimoChequeo = 0;
  const chequearUpdate = () => {
    if (document.visibilityState !== 'visible') return;
    const ahora = Date.now();
    if (ahora - ultimoChequeo < 30_000) return;
    ultimoChequeo = ahora;
    navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
  };
  document.addEventListener('visibilitychange', chequearUpdate);
  window.addEventListener('focus', chequearUpdate);
  setInterval(chequearUpdate, 120_000);
}

// Versión vieja cacheada: el index.html viejo pide un chunk JS que ya no existe
// (tras un deploy) → Vite dispara 'vite:preloadError'. Limpiamos caché + hard
// reload UNA vez para traer la versión fresca en vez de dejar la pantalla rota.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  void intentarAutoRecarga();
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <TenantProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </TenantProvider>
    </ErrorBoundary>
  </StrictMode>
);
