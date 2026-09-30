import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrCreateSocioCustomer } from '../../netlify/functions/_lib/connectBilling';
import { crearPresupuesto, PresupuestoAgotado } from '../../netlify/functions/_lib/operacionPago';

/**
 * PKG-01C · customer del miembro en la cuenta conectada: key por (cuenta,
 * usuario), resultado del upsert comprobado, presupuesto opcional. NO resuelve
 * C24 (customer borrado, id no ligado a la cuenta, duplicados históricos).
 */

const upsert = vi.fn();
function admin(stripeCustomerId: string | null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : null, error: null })) })) })),
      upsert
    }))
  } as unknown as SupabaseClient;
}
const create = vi.fn(async (_params: unknown, _opts: Record<string, unknown>) => ({ id: 'cus_new' }));
const list = vi.fn(async (_params: unknown, _opts: unknown) => ({ data: [] as unknown[] }));
const stripe = { customers: { create, list } } as unknown as Stripe;
const SOCIO = { id: 'u1', tenant_id: 't1', email: 'm@e.test' };

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({ error: null });
});

describe('getOrCreateSocioCustomer (PKG-01C)', () => {
  it('26 · la key incluye la cuenta conectada: ekko:v1:cus:<acct>:<usuario>', async () => {
    expect(await getOrCreateSocioCustomer(stripe, admin(null), SOCIO, 'acct_1')).toBe('cus_new');
    expect(create.mock.calls[0][1]).toEqual({ idempotencyKey: 'ekko:v1:cus:acct_1:u1', stripeAccount: 'acct_1' });
  });

  it('el customer guardado se reutiliza sin llamar a Stripe', async () => {
    expect(await getOrCreateSocioCustomer(stripe, admin('cus_prev'), SOCIO, 'acct_1')).toBe('cus_prev');
    expect(create).not.toHaveBeenCalled();
  });

  it('upsert fallido → queda registrado (sin PII) y el cobro no se aborta', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    upsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });
    expect(await getOrCreateSocioCustomer(stripe, admin(null), SOCIO, 'acct_1')).toBe('cus_new');
    const log = err.mock.calls.map((c) => String(c[0])).find((l) => l.includes('customer_persist_fallido'))!;
    expect(JSON.parse(log)).toMatchObject({ evento: 'customer_persist_fallido', usuario_id: 'u1', stripe_account: 'acct_1', codigo: '42501' });
    expect(log).not.toMatch(/m@e\.test/);
  });

  it('con presupuesto: create sin reintentos del SDK y con timeout acotado', async () => {
    await getOrCreateSocioCustomer(stripe, admin(null), SOCIO, 'acct_1', { presupuesto: crearPresupuesto() });
    expect(create.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'ekko:v1:cus:acct_1:u1', stripeAccount: 'acct_1', maxNetworkRetries: 0, timeout: 4000 });
  });

  it('25 · sin presupuesto para mutar → no se crea el customer', async () => {
    let t = 0;
    const p = crearPresupuesto({ ahora: () => t });
    t = 7000;
    await expect(getOrCreateSocioCustomer(stripe, admin(null), SOCIO, 'acct_1', { presupuesto: p })).rejects.toBeInstanceOf(PresupuestoAgotado);
    expect(create).not.toHaveBeenCalled();
  });
});
