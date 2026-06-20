import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: true,
    // Env placeholder para tests: algunos módulos importan el cliente real de
    // Supabase (createClient) al cargar; sin estas vars tira "supabaseUrl is
    // required" en CI (que no tiene .env.local). Valores dummy con formato
    // válido — los tests que tocan datos mockean supabase igual.
    env: {
      VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key'
    }
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@public': path.resolve(__dirname, './src/public'),
      '@member': path.resolve(__dirname, './src/member'),
      '@admin': path.resolve(__dirname, './src/admin'),
      '@reception': path.resolve(__dirname, './src/reception'),
      '@styles': path.resolve(__dirname, './src/styles')
    }
  }
});
