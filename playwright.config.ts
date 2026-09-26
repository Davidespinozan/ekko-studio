import { defineConfig, devices } from '@playwright/test';

const PUERTO_E2E = 5187;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.E2E_BASE_URL || `http://localhost:${PUERTO_E2E}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] }
    }
  ],
  webServer: process.env.CI
    ? undefined
    : {
        // Puerto PROPIO: en esta máquina conviven varios proyectos (SALA, HSC) y
        // con el 5173 compartido el smoke corría contra el dev server de OTRA app
        // (el título decía "SALA Studio" y pasaban 5 de 6 pruebas por casualidad).
        command: `npm run dev -- --port ${PUERTO_E2E} --strictPort`,
        url: `http://localhost:${PUERTO_E2E}`,
        reuseExistingServer: true,
        timeout: 60000
      }
});
