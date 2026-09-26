import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `stripe-billing-info` (A11): el historial trae CONCEPTO (membresía / paquete /
 * invitados extra, con el nombre del plan), el recibo de Stripe y los
 * reembolsos. Antes un cargo devuelto decía "Pagado" y nada decía qué se cobró.
 */

const h = vi.hoisted(() => ({
  charges: [] as Record<string, unknown>[],
  tiers: [{ id: 'tier-esencial', nombre: 'Esencial' }, { id: 'tier-4h', nombre: '4 horas' }],
  listCharges: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const result =
        table === 'usuarios' ? { data: { id: 'u1', tenant_id: 't1' }, error: null }
        : table === 'usuarios_datos_privados' ? { data: { stripe_customer_id: 'cus_1' }, error: null }
        : table === 'tenants' ? { data: { stripe_account_id: 'acct_1' }, error: null }
        : table === 'tiers' ? { data: h.tiers, error: null }
        : { data: null, error: null };
      for (const m of ['select', 'eq', 'not', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve(result);
      b.then = (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb);
      return b;
    }
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({
    customers: { retrieve: vi.fn().mockResolvedValue({ invoice_settings: { default_payment_method: null } }) },
    paymentMethods: { list: vi.fn().mockResolvedValue({ data: [] }) },
    charges: { list: (...a: unknown[]) => h.listCharges(...a) }
  })
}));

import { handler, conceptoDeCargo } from '../../netlify/functions/stripe-billing-info/index';

async function invocar() {
  const res = await handler(
    { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: '{}' } as never,
    {} as never,
    () => {}
  );
  const r = res as { statusCode: number; body: string };
  return { status: r.statusCode, json: JSON.parse(r.body) };
}

const cargo = (extra: Record<string, unknown>) => ({
  id: 'ch_1', amount: 85000, currency: 'mxn', created: 1_700_000_000, status: 'succeeded',
  refunded: false, amount_refunded: 0, receipt_url: 'https://pay.stripe.com/receipts/x', description: null, metadata: {},
  invoice: null, ...extra
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  h.listCharges.mockImplementation(() => Promise.resolve({ data: h.charges }));
});

describe('conceptoDeCargo', () => {
  const nombre = (id?: string) => (id === 'tier-esencial' ? 'Esencial' : id === 'tier-4h' ? '4 horas' : null);

  it('paquete por PaymentIntent: metadata.tier_id → "Paquete · <plan>"', () => {
    expect(conceptoDeCargo({ metadata: { tier_id: 'tier-4h' } }, nombre)).toBe('Paquete · 4 horas');
  });

  it('invitados extra con cantidad', () => {
    expect(conceptoDeCargo({ metadata: { tipo: 'invitados_extra', cantidad: '2' } }, nombre)).toBe('Invitados extra (2)');
  });

  it('renovación por invoice: el plan sale de la metadata de la suscripción', () => {
    const invoice = { billing_reason: 'subscription_cycle', parent: { subscription_details: { metadata: { tier_id: 'tier-esencial' } } } };
    expect(conceptoDeCargo({ metadata: {}, invoice }, nombre)).toBe('Renovación de membresía · Esencial');
  });

  it('alta por invoice sin plan conocido → "Membresía"', () => {
    expect(conceptoDeCargo({ metadata: {}, invoice: { billing_reason: 'subscription_create' } }, nombre)).toBe('Membresía');
  });

  it('sin pistas usa la descripción del cargo o "Cobro"', () => {
    expect(conceptoDeCargo({ description: 'Ajuste', metadata: {} }, nombre)).toBe('Ajuste');
    expect(conceptoDeCargo({ metadata: {} }, nombre)).toBe('Cobro');
  });
});

describe('stripe-billing-info · historial', () => {
  it('devuelve concepto, recibo y estado por cargo; un cargo devuelto es "refunded"', async () => {
    h.charges = [
      cargo({ id: 'ch_a', metadata: { tier_id: 'tier-4h' } }),
      cargo({ id: 'ch_b', refunded: true, amount_refunded: 85000, metadata: { tier_id: 'tier-esencial' } }),
      cargo({ id: 'ch_c', amount_refunded: 20000, metadata: { tipo: 'invitados_extra', cantidad: '1' } })
    ];
    const { status, json } = await invocar();
    expect(status).toBe(200);
    expect(json.pagos).toHaveLength(3);
    expect(json.pagos[0]).toMatchObject({ id: 'ch_a', status: 'succeeded', descripcion: 'Paquete · 4 horas', receipt_url: 'https://pay.stripe.com/receipts/x', reembolsado_centavos: 0 });
    expect(json.pagos[1]).toMatchObject({ id: 'ch_b', status: 'refunded', reembolsado_centavos: 85000 });
    expect(json.pagos[2]).toMatchObject({ id: 'ch_c', status: 'succeeded', descripcion: 'Invitados extra (1)', reembolsado_centavos: 20000 });
  });

  it('pide el invoice expandido para poder nombrar el plan de una renovación', async () => {
    h.charges = [];
    await invocar();
    expect(h.listCharges).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', expand: ['data.invoice'] }),
      expect.objectContaining({ stripeAccount: 'acct_1' })
    );
  });

  it('si Stripe falla al listar, responde igual con la tarjeta y sin historial (no 500)', async () => {
    h.listCharges.mockRejectedValueOnce(new Error('rate limit'));
    const { status, json } = await invocar();
    expect(status).toBe(200);
    expect(json.pagos).toEqual([]);
  });
});
