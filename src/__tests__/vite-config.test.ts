// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PKG-06D (FR-37) · El build de producción no publica source maps. Con Sentry
 * configurado (hoy no lo está) se generan 'hidden' y el plugin los borra de dist
 * tras subirlos. En desarrollo siguen activos. `vite.config.ts` pertenece al
 * proyecto de Node (tsconfig.node.json), así que el contrato se fija sobre el
 * texto de la configuración, no importándola.
 */

const cfg = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8');

describe('vite.config · source maps', () => {
  it('35 · producción sin Sentry: sourcemap=false; con Sentry: hidden; desarrollo: true', () => {
    expect(cfg).toMatch(/sourcemap: isProduction \? \(hasSentryConfig \? 'hidden' : false\) : true,/);
    expect(cfg).not.toMatch(/sourcemap: isProduction,/);
    expect(cfg).not.toMatch(/sourcemap: true,/);
  });

  it('con Sentry configurado los mapas se borran de dist tras subirlos (nunca públicos)', () => {
    expect(cfg).toMatch(/filesToDeleteAfterUpload: \['\.\/dist\/\*\*\/\*\.map'\]/);
    expect(cfg).toMatch(/isProduction && hasSentryConfig && sentryVitePlugin\(/);
  });

  it('36 · hasSentryConfig exige las tres variables (sin ellas el plugin ni se carga)', () => {
    expect(cfg).toMatch(/process\.env\.SENTRY_AUTH_TOKEN &&\s*process\.env\.SENTRY_ORG &&\s*process\.env\.SENTRY_PROJECT/);
  });
});
