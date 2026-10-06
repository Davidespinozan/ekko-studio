import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PKG-06D (FR-25 / FR-37) · La política de seguridad de contenido y el bloqueo
 * de source maps viven en netlify.toml; esto fija el contrato exacto para que un
 * cambio accidental (un comodín, unsafe-eval, un origen de más) no pase el gate.
 */

const ROOT = resolve(__dirname, '../..');
const toml = readFileSync(resolve(ROOT, 'netlify.toml'), 'utf8');
const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const SUPABASE = 'https://cfihcrjbvgjiohedsjos.supabase.co';

function csp(): Record<string, string[]> {
  const m = toml.match(/Content-Security-Policy = "([^"]+)"/);
  expect(m, 'netlify.toml declara Content-Security-Policy').toBeTruthy();
  const out: Record<string, string[]> = {};
  for (const d of m![1].split(';')) {
    const [nombre, ...valores] = d.trim().split(/\s+/);
    if (nombre) out[nombre] = valores;
  }
  return out;
}

describe('Content-Security-Policy (netlify.toml, /*)', () => {
  const p = csp();

  it('13/14 · existe y no tiene comodines amplios', () => {
    expect(p['default-src']).toEqual(["'self'"]);
    for (const [d, v] of Object.entries(p)) {
      expect(v, d).not.toContain('*');
      expect(v, d).not.toContain('https:');
      expect(v, d).not.toContain('http:');
    }
  });

  it('15 · sin unsafe-eval en ninguna directiva; sin unsafe-inline en scripts', () => {
    const todo = Object.values(p).flat();
    expect(todo).not.toContain("'unsafe-eval'");
    expect(p['script-src']).toEqual(["'self'", 'https://js.stripe.com']);
  });

  it('16 · Supabase (REST/Auth/Storage y websocket) permitido en connect-src; el host es el del proyecto', () => {
    expect(p['connect-src']).toContain(SUPABASE);
    expect(p['connect-src']).toContain(SUPABASE.replace('https://', 'wss://'));
    expect(p['connect-src']).toContain("'self'");
    const ejemplo = readFileSync(resolve(ROOT, '.env.example'), 'utf8').match(/VITE_SUPABASE_URL=(\S+)/)?.[1];
    expect(ejemplo).toBe(SUPABASE);
  });

  it('17 · Stripe solo donde EKKO lo usa: script, API, iframes y 3DS; imágenes de Stripe', () => {
    expect(p['connect-src']).toContain('https://api.stripe.com');
    expect(p['frame-src']).toEqual(['https://js.stripe.com', 'https://hooks.stripe.com']);
    expect(p['img-src']).toEqual(["'self'", 'data:', 'blob:', SUPABASE, 'https://*.stripe.com']);
    // Nada más: ni analítica, ni Sentry (no configurado), ni CDNs.
    const hosts = Object.values(p).flat().filter((v) => v.startsWith('https://') || v.startsWith('wss://'));
    expect(new Set(hosts.map((h) => h.replace('wss://', 'https://')))).toEqual(new Set([
      'https://js.stripe.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', SUPABASE, 'https://*.stripe.com', 'https://api.stripe.com', 'https://hooks.stripe.com'
    ]));
  });

  it('18 · protección de marcos: frame-ancestors none + X-Frame-Options DENY; object-src none; base-uri/form-action self', () => {
    expect(p['frame-ancestors']).toEqual(["'none'"]);
    expect(toml).toMatch(/X-Frame-Options = "DENY"/);
    expect(p['object-src']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'self'"]);
    expect(p['form-action']).toEqual(["'self'"]);
  });

  it('19 · recursos del sitio: fuentes de Google, estilos propios, worker/manifest propios, cámara por blob', () => {
    expect(p['style-src']).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
    expect(p['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
    expect(p['worker-src']).toEqual(["'self'"]);
    expect(p['manifest-src']).toEqual(["'self'"]);
    expect(p['media-src']).toEqual(["'self'", 'blob:']);
    expect(p['upgrade-insecure-requests']).toEqual([]);
  });

  it('index.html no tiene scripts inline ejecutables ni <style>: script-src estricto es viable', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    for (const attrs of scripts) {
      expect(/\bsrc=/.test(attrs) || /type="application\/ld\+json"/.test(attrs), attrs).toBe(true);
    }
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('source maps (FR-37)', () => {
  it('35 · ningún .map se sirve: redirect forzado a 404', () => {
    expect(toml).toMatch(/from = "\/\*\.map"\n\s+to = "\/index\.html"\n\s+status = 404\n\s+force = true/);
  });
});
