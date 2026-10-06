import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';
  const hasSentryConfig = Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
  );

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
        manifest: {
          name: 'EKKO Studio',
          short_name: 'EKKO',
          description: 'Tu espacio para crear contenido profesional',
          theme_color: '#0A0A0A',
          background_color: '#0A0A0A',
          display: 'standalone',
          orientation: 'portrait',
          scope: '/',
          start_url: '/',
          lang: 'es-MX',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
          ]
        },
        workbox: {
          // Borra los precaches de versiones anteriores al activar el SW nuevo:
          // sin esto, tras varios deploys el dispositivo acumula caches viejos.
          cleanupOutdatedCaches: true,
          // Inyecta los handlers de Web Push en el SW de Workbox (push-sw.js
          // vive en /public). Así el push convive con el caché sin un 2º SW.
          importScripts: ['push-sw.js'],
          navigateFallbackDenylist: [/^\/api/, /^\/.netlify/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
              handler: 'NetworkOnly'
            }
          ]
        }
      }),
      isProduction && hasSentryConfig && sentryVitePlugin({
        org: process.env.SENTRY_ORG!,
        project: process.env.SENTRY_PROJECT!,
        authToken: process.env.SENTRY_AUTH_TOKEN!,
        // PKG-06D (FR-37): si algún día se configura Sentry, los mapas se suben
        // y se BORRAN de dist antes de publicar; nunca quedan descargables.
        sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] }
      })
    ].filter(Boolean),
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, './src/shared'),
        '@public': path.resolve(__dirname, './src/public'),
        '@member': path.resolve(__dirname, './src/member'),
        '@admin': path.resolve(__dirname, './src/admin'),
        '@reception': path.resolve(__dirname, './src/reception'),
        '@styles': path.resolve(__dirname, './src/styles')
      }
    },
    build: {
      outDir: 'dist',
      // PKG-06D (FR-37): en producción no se publican source maps (eran
      // descargables en /assets/*.js.map). Con Sentry configurado se generan
      // 'hidden' (sin comentario sourceMappingURL) y el plugin los borra tras
      // subirlos. En desarrollo siguen activos.
      sourcemap: isProduction ? (hasSentryConfig ? 'hidden' : false) : true,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-supabase': ['@supabase/supabase-js'],
            'vendor-sentry': ['@sentry/react']
          }
        }
      }
    },
    server: {
      port: 5173,
      host: true
    }
  };
});
