import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PKG-03B fase D · `cron-reconciliar-stripe`: envoltorio delgado del MISMO núcleo
 * que el endpoint manual, sin token (lo programa Netlify), con la MISMA fachada de
 * Stripe de solo lectura. Horario: 09:00 UTC diario. Sin llamadas reales a Stripe.
 */

const h = vi.hoisted(() => ({
  reconciliar: vi.fn(),
  lectura: vi.fn(),
  reportar: vi.fn().mockResolvedValue(undefined),
  usados: [] as string[]
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ marca: 'admin' })) }));
// Stripe real sustituido por una trampa: cualquier método fuera de las dos lecturas revienta.
vi.mock('../../netlify/functions/_lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/stripe')>()),
  getStripe: () => {
    const trampa = (ruta: string): unknown => new Proxy(() => undefined, {
      get: (_t, p: string) => {
        const r = `${ruta}.${p}`;
        if (r === 'stripe.accounts.retrieve') return async () => { h.usados.push(r); return { metadata: { app: 'ekko' } }; };
        if (r === 'stripe.subscriptions.list') return async () => { h.usados.push(r); return { data: [], has_more: false }; };
        if (['stripe.accounts', 'stripe.subscriptions'].includes(r) || ruta === 'stripe') return trampa(r);
        throw new Error(`método de Stripe NO permitido desde el cron: ${r}`);
      }
    });
    return trampa('stripe');
  }
}));
vi.mock('../../netlify/functions/_lib/reconciliacionStripe', async (orig) => {
  const real = await orig<typeof import('../../netlify/functions/_lib/reconciliacionStripe')>();
  return {
    ...real,
    lecturaStripe: (s: unknown) => { h.lectura(s); return real.lecturaStripe(s as never); },
    reconciliarStripe: (...a: unknown[]) => h.reconciliar(...a)
  };
});
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => h.reportar(...a) }));

import { handler } from '../../netlify/functions/cron-reconciliar-stripe/index';

const correr = async () => {
  const r = (await handler({} as never, {} as never)) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.usados.length = 0;
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  delete process.env.RECONCILIAR_STRIPE_TOKEN;
  h.reconciliar.mockResolvedValue({ corrida_id: 'c1', estudios: [{ tenant_id: 't1', estado: 'completa', suscripciones_leidas: 3, discrepancias: 0, error: null }] });
});

describe('cron-reconciliar-stripe', () => {
  it('1 · 3 · invoca el MISMO núcleo (reconciliarStripe) con la fachada de solo lectura, sin exigir ningún token', async () => {
    const r = await correr();
    expect(r.status).toBe(200);
    expect(h.reconciliar).toHaveBeenCalledTimes(1);
    const [admin, fachada] = h.reconciliar.mock.calls[0] as [unknown, { cuentaEsDeEkko: unknown; listarSuscripciones: unknown }];
    expect(admin).toEqual({ marca: 'admin' });
    expect(Object.keys(fachada).sort()).toEqual(['cuentaEsDeEkko', 'listarSuscripciones']);
    expect(h.lectura).toHaveBeenCalledTimes(1);
    expect(r.body).toEqual({ corrida_id: 'c1', estudios: [expect.objectContaining({ estado: 'completa' })] });
  });

  it('5 · la fachada que recibe el núcleo solo puede alcanzar accounts.retrieve y subscriptions.list', async () => {
    await correr();
    const fachada = h.reconciliar.mock.calls[0][1] as { cuentaEsDeEkko: (a: string) => Promise<boolean>; listarSuscripciones: (a: string) => Promise<unknown> };
    expect(await fachada.cuentaEsDeEkko('acct_1')).toBe(true);
    await fachada.listarSuscripciones('acct_1');
    expect(h.usados).toEqual(['stripe.accounts.retrieve', 'stripe.subscriptions.list']);
  });

  it('sin Stripe configurado no corre (skipped); un error del núcleo se reporta y responde 500', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await correr()).toEqual({ status: 200, body: { skipped: 'stripe_no_configurado' } });
    expect(h.reconciliar).not.toHaveBeenCalled();
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    h.reconciliar.mockRejectedValue(new Error('registrar_reconciliacion_stripe: boom'));
    expect((await correr()).status).toBe(500);
    expect(h.reportar).toHaveBeenCalledWith('cron-reconciliar-stripe', expect.any(Error));
  });

  it('2 · está programado exactamente a las 09:00 UTC diario, con la sintaxis real de Netlify; el manual no tiene horario', () => {
    const toml = readFileSync(resolve(__dirname, '../../netlify.toml'), 'utf8');
    const m = toml.match(/\[functions\."cron-reconciliar-stripe"\]\s*\n\s*schedule\s*=\s*"([^"]+)"/);
    expect(m?.[1]).toBe('0 9 * * *');
    expect(toml).not.toMatch(/\[functions\."reconciliar-stripe"\]/);
  });

  it('14 · la automatización histórica de huérfanas (cron-expirar-membresias) no cambia con la fase D', () => {
    const toml = readFileSync(resolve(__dirname, '../../netlify.toml'), 'utf8');
    expect(toml).toMatch(/\[functions\."cron-expirar-membresias"\]\s*\n\s*schedule\s*=\s*"0 7 \* \* \*"/);
    const src = readFileSync(resolve(__dirname, '../../netlify/functions/cron-expirar-membresias/index.ts'), 'utf8');
    expect(src).toContain("'cancelada', 'expirada'");
    expect(src).not.toMatch(/reconciliarStripe|discrepancias_stripe/);
    const cron = readFileSync(resolve(__dirname, '../../netlify/functions/cron-reconciliar-stripe/index.ts'), 'utf8');
    expect(cron).not.toMatch(/subscriptions\.(cancel|update)|expirar_membresias|reconciliarSubsHuerfanas/);
  });
});
