import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-03B · `reconciliar-stripe`: corrida MANUAL, deshabilitada sin token. Nunca
 * hay llamadas reales a Stripe; el núcleo se prueba en reconciliacion-stripe.test.ts.
 */

const h = vi.hoisted(() => ({ reconciliar: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('../../netlify/functions/_lib/stripe', () => ({ getStripe: () => ({}) }));
vi.mock('../../netlify/functions/_lib/reconciliacionStripe', () => ({
  lecturaStripe: () => ({}),
  reconciliarStripe: (...a: unknown[]) => h.reconciliar(...a)
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: vi.fn() }));

import { handler } from '../../netlify/functions/reconciliar-stripe/index';

const invocar = async (headers: Record<string, string> = {}, method = 'POST') =>
  (await handler({ httpMethod: method, headers, body: '' } as never, {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  delete process.env.RECONCILIAR_STRIPE_TOKEN;
  h.reconciliar.mockResolvedValue({ corrida_id: 'c1', estudios: [] });
});

describe('reconciliar-stripe', () => {
  it('sin token configurado está DESHABILITADA (403) aunque el llamante mande algo', async () => {
    expect((await invocar({ authorization: 'Bearer cualquiera' })).statusCode).toBe(403);
    expect(h.reconciliar).not.toHaveBeenCalled();
  });

  it('con token: exige el mismo Bearer; otro o ninguno → 403; GET → 400', async () => {
    process.env.RECONCILIAR_STRIPE_TOKEN = 'secreto-de-prueba-123';
    expect((await invocar()).statusCode).toBe(403);
    expect((await invocar({ authorization: 'Bearer otro' })).statusCode).toBe(403);
    expect((await invocar({ authorization: 'Bearer secreto-de-prueba-123' }, 'GET')).statusCode).toBe(400);
    expect(h.reconciliar).not.toHaveBeenCalled();
    const r = await invocar({ authorization: 'Bearer secreto-de-prueba-123' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ corrida_id: 'c1', estudios: [] });
  });

  it('un error del núcleo responde 500 sin detalles internos', async () => {
    process.env.RECONCILIAR_STRIPE_TOKEN = 't';
    h.reconciliar.mockRejectedValue(new Error('detalle interno'));
    const r = await invocar({ authorization: 'Bearer t' });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('detalle interno');
  });
});
