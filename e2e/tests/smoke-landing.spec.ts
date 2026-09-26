import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Smokes de humo, read-only, contra el tenant que carga en localhost (EKKO). No
 * requieren login ni mutan datos. Cubren las regresiones que más duelen y que
 * ningún test unitario ve: pantalla en blanco / ErrorBoundary, desborde horizontal
 * en móvil, rutas rotas y errores de consola. (Portado de SALA smoke-landing.)
 */

// Ruido de consola que NO cuenta como fallo (3rd-party / infra esperada).
const RUIDO = [
  /sentry/i,
  /favicon/i,
  /manifest/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /interactive-widget/i, // WebKit: warning del meta viewport
  /service worker/i
];

function capturarErrores(page: Page): string[] {
  const errores: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error' && !RUIDO.some((r) => r.test(msg.text()))) errores.push(msg.text());
  });
  page.on('pageerror', (err) => errores.push(err.message));
  return errores;
}

test.describe('Landing pública', () => {
  test('renderiza hasta el pie sin crash ni errores de consola', async ({ page }) => {
    const errores = capturarErrores(page);
    await page.goto('/');
    // Título = nombre del tenant (el TenantProvider lo pone) o el SEO estático.
    await expect(page).toHaveTitle(/EKKO/i);
    // El árbol llegó hasta el footer: no quedó en loading ni en la pantalla de error.
    await expect(page.locator('footer')).toBeVisible();
    expect(errores, `errores de consola:\n${errores.join('\n')}`).toEqual([]);
  });

  test('sin desborde horizontal en viewport móvil', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14 lógico
    await page.goto('/');
    await expect(page.locator('footer')).toBeVisible();
    const desborda = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(desborda, 'la página desborda horizontalmente en móvil').toBe(false);
  });
});

test.describe('Auth / routing público', () => {
  test('/login muestra el formulario', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    // Deshabilitado hasta llenar el form, pero visible.
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
    await expect(page.getByRole('link', { name: /olvidaste tu contraseña/i })).toBeVisible();
  });

  test('/signup sin plan manda a elegir uno en el landing', async ({ page }) => {
    await page.goto('/signup');
    // Sin ?tier=<slug> el alta no tiene qué cobrar: redirige a la sección de planes.
    await expect(page).toHaveURL(/#membresias$/);
    await expect(page.locator('footer')).toBeVisible();
  });

  test('desde un plan del landing se llega al alta (sin enviarla: no crea cuentas)', async ({ page }) => {
    const errores = capturarErrores(page);
    await page.goto('/');
    const enlacePlan = page.locator('a[href*="/signup?tier="]').first();
    // Los planes se cargan de la base (en_venta): esperarlos antes de decidir.
    await enlacePlan.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    // Un estudio sin planes en venta no tiene alta: el smoke no inventa uno.
    test.skip((await enlacePlan.count()) === 0, 'no hay planes en venta en este entorno');
    await enlacePlan.click();
    await expect(page.locator('#signup-email')).toBeVisible();
    expect(errores, `errores de consola:\n${errores.join('\n')}`).toEqual([]);
  });

  test('una ruta desconocida no rompe la app', async ({ page }) => {
    const errores = capturarErrores(page);
    await page.goto('/ruta-que-no-existe-12345');
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(errores, `errores de consola:\n${errores.join('\n')}`).toEqual([]);
  });

  test('/app sin sesión manda al login (no pantalla en blanco)', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});
