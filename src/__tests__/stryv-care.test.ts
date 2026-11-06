import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * stryv-care (EKKO-149): los planes que STRYV le cobra al estudio (Care y Grow) en
 * la cuenta de la PLATAFORMA (sin `stripeAccount`). Solo el admin activo; el cliente
 * de Stripe es el estudio (uno por slug, compartido por los planes); cada plan tiene
 * su producto, precio y portal, creados una vez con llaves estables; una suscripción
 * viva del plan no se duplica y tener un plan no impide activar el otro. Nada toca la
 * base de EKKO.
 */

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  adminMaybe: vi.fn(),
  tenantMaybe: vi.fn(),
  S: {
    customers: { search: vi.fn(), create: vi.fn() },
    prices: { list: vi.fn(), create: vi.fn() },
    billingPortal: { configurations: { list: vi.fn(), create: vi.fn() }, sessions: { create: vi.fn() } },
    subscriptions: { list: vi.fn() },
    invoices: { list: vi.fn() },
    checkout: { sessions: { create: vi.fn() } }
  },
  getStripe: vi.fn(),
  reportar: vi.fn(async () => {})
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: h.getUser },
    from: vi.fn((table: string) => {
      const maybe = table === 'usuarios' ? h.adminMaybe : h.tenantMaybe;
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: maybe })) })) };
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({ getStripe: () => h.getStripe() }));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: h.reportar }));

import { handler, PLANES, claveTenant, finPeriodo, lookupKey, planDesde, precioCentavos, suscripcionDelPlan } from '../../netlify/functions/stryv-care/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (body: Record<string, unknown> | undefined = { action: 'status' }): AnyEvent =>
  ({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok', origin: 'https://ekko.test' },
    body: JSON.stringify(body ?? {})
  } as unknown as AnyEvent);
const invocar = async (ev: AnyEvent = evento()) =>
  (await handler(ev, {} as never, () => {})) as { statusCode: number; body: string };
const cuerpo = (res: { body: string }) => JSON.parse(res.body);

const CUSTOMER = { id: 'cus_ekko', metadata: { app: 'stryv-care', stryv_care_tenant: 'ekko' } };
const SUB_CARE = {
  id: 'sub_care',
  status: 'active',
  cancel_at_period_end: false,
  metadata: { app: 'stryv-care', stryv_plan: 'care' },
  items: { data: [{ current_period_end: 1798761600 }] },
  default_payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242' } }
};
const SUB_GROW = {
  id: 'sub_grow',
  status: 'active',
  cancel_at_period_end: false,
  metadata: { app: 'stryv-grow', stryv_plan: 'grow' },
  items: { data: [{ current_period_end: 1801440000 }] },
  default_payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242' } }
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  delete process.env.STRYV_CARE_CENTAVOS;
  delete process.env.STRYV_GROW_CENTAVOS;
  h.getStripe.mockReturnValue(h.S);
  h.getUser.mockResolvedValue({ data: { user: { id: 'auth-1', email: 'admin@ekko.test' } }, error: null });
  h.adminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'activo' }, error: null });
  h.tenantMaybe.mockResolvedValue({ data: { slug: 'ekko', nombre: 'EKKO Studio' }, error: null });
  h.S.customers.search.mockResolvedValue({ data: [] });
  h.S.customers.create.mockResolvedValue(CUSTOMER);
  h.S.prices.list.mockResolvedValue({ data: [] });
  h.S.prices.create.mockResolvedValue({ id: 'price_nuevo' });
  h.S.billingPortal.configurations.list.mockResolvedValue({ data: [] });
  h.S.billingPortal.configurations.create.mockResolvedValue({ id: 'bpc_new' });
  h.S.billingPortal.sessions.create.mockResolvedValue({ url: 'https://portal.stripe.test/x' });
  h.S.subscriptions.list.mockResolvedValue({ data: [] });
  h.S.invoices.list.mockResolvedValue({ data: [] });
  h.S.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.test/x' });
});

describe('stryv-care · acceso', () => {
  it('recepcionista → 403 y no se habla con Stripe', async () => {
    h.adminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'recepcionista', status: 'activo' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(403);
    expect(h.getStripe).not.toHaveBeenCalled();
  });

  it('admin revocado → 403 aunque conserve el rol', async () => {
    h.adminMaybe.mockResolvedValue({ data: { tenant_id: 't1', rol: 'admin', status: 'revocado' }, error: null });
    expect((await invocar()).statusCode).toBe(403);
  });

  it('sin token → 401; acción o plan desconocidos → 400', async () => {
    const sinToken = { ...evento(), headers: {} } as unknown as AnyEvent;
    expect((await invocar(sinToken)).statusCode).toBe(401);
    expect((await invocar(evento({ action: 'borrar' }))).statusCode).toBe(400);
    expect((await invocar(evento({ action: 'status', plan: 'premium' }))).statusCode).toBe(400);
  });

  it('sin STRIPE_SECRET_KEY → estado no_disponible del plan (tras validar al admin)', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await invocar(evento({ action: 'status', plan: 'grow' }));
    expect(res.statusCode).toBe(200);
    expect(cuerpo(res)).toEqual({ plan: 'grow', estado: 'no_disponible' });
    expect(h.getStripe).not.toHaveBeenCalled();
  });

  it('slug del estudio inválido para la búsqueda → 403, nunca se arma la query', async () => {
    h.tenantMaybe.mockResolvedValue({ data: { slug: "x' OR 1", nombre: 'X' }, error: null });
    expect((await invocar()).statusCode).toBe(403);
    expect(h.S.customers.search).not.toHaveBeenCalled();
  });
});

describe('stryv-care · status', () => {
  it('sin plan en el body = Care; sin cliente en Stripe → inactivo con el precio; no crea nada', async () => {
    const res = await invocar(evento({ action: 'status' }));
    expect(cuerpo(res)).toEqual({ plan: 'care', estado: 'inactivo', monto_centavos: 250000, puede_activar: true });
    expect(h.S.customers.search).toHaveBeenCalledWith({ query: "metadata['stryv_care_tenant']:'ekko'", limit: 1 });
    expect(h.S.customers.create).not.toHaveBeenCalled();
    expect(h.S.subscriptions.list).not.toHaveBeenCalled();
  });

  it('Grow sin activar → su precio ($6,500)', async () => {
    const b = cuerpo(await invocar(evento({ action: 'status', plan: 'grow' })));
    expect(b).toEqual({ plan: 'grow', estado: 'inactivo', monto_centavos: 650000, puede_activar: true });
  });

  it('cada plan ve SOLO su suscripción: con Care y Grow vivas, Care no se confunde con Grow', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.subscriptions.list.mockResolvedValue({ data: [SUB_GROW, SUB_CARE] });
    h.S.invoices.list.mockResolvedValue({
      data: [{ created: 1796083200, amount_paid: 250000, amount_due: 250000, status: 'paid', hosted_invoice_url: 'https://inv/1' }]
    });
    const care = cuerpo(await invocar(evento({ action: 'status', plan: 'care' })));
    expect(care.estado).toBe('active');
    expect(care.proximo_cobro).toBe(1798761600);
    expect(care.termina).toBeNull();
    expect(care.tarjeta).toEqual({ marca: 'visa', last4: '4242' });
    expect(care.recibos).toEqual([{ fecha: 1796083200, monto_centavos: 250000, estado: 'paid', url: 'https://inv/1' }]);
    // Los recibos son los de SU suscripción, no todos los del cliente.
    expect(h.S.invoices.list).toHaveBeenCalledWith({ customer: 'cus_ekko', subscription: 'sub_care', limit: 6 });
    // Plataforma: sin `stripeAccount` (la cuenta conectada del estudio no interviene).
    expect(h.S.subscriptions.list.mock.calls[0]).toHaveLength(1);

    const grow = cuerpo(await invocar(evento({ action: 'status', plan: 'grow' })));
    expect(grow.proximo_cobro).toBe(1801440000);
    expect(h.S.invoices.list).toHaveBeenLastCalledWith({ customer: 'cus_ekko', subscription: 'sub_grow', limit: 6 });
  });

  it('con solo Care viva, Grow sigue inactivo y no pide recibos', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.subscriptions.list.mockResolvedValue({ data: [SUB_CARE] });
    const grow = cuerpo(await invocar(evento({ action: 'status', plan: 'grow' })));
    expect(grow.estado).toBe('inactivo');
    expect(grow.monto_centavos).toBe(650000);
    expect(h.S.invoices.list).not.toHaveBeenCalled();
  });

  it('cancelación programada → termina en vez de próximo cobro; una `incomplete` no cuenta como viva', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.subscriptions.list.mockResolvedValue({
      data: [{ id: 'sub_i', status: 'incomplete', metadata: { app: 'stryv-care' } }, { ...SUB_CARE, cancel_at_period_end: true }]
    });
    const b = cuerpo(await invocar());
    expect(b.estado).toBe('active');
    expect(b.termina).toBe(1798761600);
    expect(b.proximo_cobro).toBeNull();
  });

  it('si los recibos fallan, el resto del estado igual se devuelve', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.subscriptions.list.mockResolvedValue({ data: [SUB_CARE] });
    h.S.invoices.list.mockRejectedValue(new Error('stripe caído'));
    const b = cuerpo(await invocar());
    expect(b.estado).toBe('active');
    expect(b.recibos).toEqual([]);
  });

  it('STRYV_CARE_CENTAVOS / STRYV_GROW_CENTAVOS cambian el precio sin tocar código; un valor inválido cae al default', async () => {
    process.env.STRYV_CARE_CENTAVOS = '400000';
    process.env.STRYV_GROW_CENTAVOS = '700000';
    expect(cuerpo(await invocar(evento({ action: 'status', plan: 'care' }))).monto_centavos).toBe(400000);
    expect(cuerpo(await invocar(evento({ action: 'status', plan: 'grow' }))).monto_centavos).toBe(700000);
    process.env.STRYV_CARE_CENTAVOS = 'gratis';
    expect(precioCentavos(PLANES.care)).toBe(250000);
    expect(precioCentavos(PLANES.grow)).toBe(700000);
  });
});

describe('stryv-care · checkout', () => {
  it('Care: crea cliente, precio y sesión con llaves estables y metadata del plan; regresa al admin', async () => {
    const res = await invocar(evento({ action: 'checkout', plan: 'care' }));
    expect(cuerpo(res)).toEqual({ url: 'https://checkout.stripe.test/x' });
    expect(h.S.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'EKKO Studio', email: 'admin@ekko.test', metadata: expect.objectContaining({ app: 'stryv-care', stryv_care_tenant: 'ekko' }) }),
      { idempotencyKey: 'stryv-care-customer-ekko' }
    );
    expect(h.S.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'mxn', unit_amount: 250000, recurring: { interval: 'month' }, lookup_key: 'stryv_care_mxn_mensual_250000', product_data: { name: 'STRYV Care', metadata: { app: 'stryv-care' } } }),
      { idempotencyKey: 'stryv-care-price-stryv_care_mxn_mensual_250000' }
    );
    expect(h.S.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_ekko',
        line_items: [{ price: 'price_nuevo', quantity: 1 }],
        metadata: { app: 'stryv-care', stryv_plan: 'care', stryv_care_tenant: 'ekko' },
        subscription_data: { metadata: { app: 'stryv-care', stryv_plan: 'care', stryv_care_tenant: 'ekko' } },
        success_url: 'https://ekko.test/admin/stryv?stryv=ok&plan=care',
        cancel_url: 'https://ekko.test/admin/stryv?stryv=cancel&plan=care'
      })
    );
  });

  it('Grow: su propio producto y precio ($6,500), mismo cliente del estudio, metadata stryv-grow', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    await invocar(evento({ action: 'checkout', plan: 'grow' }));
    expect(h.S.customers.create).not.toHaveBeenCalled();
    expect(h.S.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({ unit_amount: 650000, lookup_key: 'stryv_grow_mxn_mensual_650000', product_data: { name: 'STRYV Grow', metadata: { app: 'stryv-grow' } } }),
      { idempotencyKey: 'stryv-care-price-stryv_grow_mxn_mensual_650000' }
    );
    expect(h.S.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_ekko',
        metadata: { app: 'stryv-grow', stryv_plan: 'grow', stryv_care_tenant: 'ekko' },
        success_url: 'https://ekko.test/admin/stryv?stryv=ok&plan=grow'
      })
    );
  });

  it('cliente y precio ya existentes se reutilizan (no se duplican)', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.prices.list.mockResolvedValue({ data: [{ id: 'price_viejo' }] });
    await invocar(evento({ action: 'checkout' }));
    expect(h.S.customers.create).not.toHaveBeenCalled();
    expect(h.S.prices.create).not.toHaveBeenCalled();
    expect(h.S.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ line_items: [{ price: 'price_viejo', quantity: 1 }] }));
  });

  it('con una suscripción viva DEL PLAN (past_due incluida) → 409; tener Care no bloquea activar Grow', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.subscriptions.list.mockResolvedValue({ data: [{ ...SUB_CARE, status: 'past_due' }] });
    const res = await invocar(evento({ action: 'checkout', plan: 'care' }));
    expect(res.statusCode).toBe(409);
    expect(cuerpo(res).error).toBe('STRYV Care ya está activo.');
    expect(h.S.checkout.sessions.create).not.toHaveBeenCalled();

    const grow = await invocar(evento({ action: 'checkout', plan: 'grow' }));
    expect(grow.statusCode).toBe(200);
    expect(h.S.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
});

describe('stryv-care · portal', () => {
  it('reutiliza la configuración propia del plan y vuelve a los planes con ?stryv=volver', async () => {
    h.S.customers.search.mockResolvedValue({ data: [CUSTOMER] });
    h.S.billingPortal.configurations.list.mockResolvedValue({
      data: [{ id: 'bpc_otra', metadata: { app: 'otra-app' } }, { id: 'bpc_care', metadata: { app: 'stryv-care' } }, { id: 'bpc_grow', metadata: { app: 'stryv-grow' } }]
    });
    const res = await invocar(evento({ action: 'portal', plan: 'care' }));
    expect(cuerpo(res)).toEqual({ url: 'https://portal.stripe.test/x' });
    expect(h.S.billingPortal.configurations.create).not.toHaveBeenCalled();
    expect(h.S.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_ekko',
      configuration: 'bpc_care',
      return_url: 'https://ekko.test/admin/stryv?stryv=volver&plan=care'
    });
    await invocar(evento({ action: 'portal', plan: 'grow' }));
    expect(h.S.billingPortal.sessions.create).toHaveBeenLastCalledWith(expect.objectContaining({ configuration: 'bpc_grow', return_url: 'https://ekko.test/admin/stryv?stryv=volver&plan=grow' }));
  });

  it('sin configuración propia la crea una vez por plan (solo tarjeta y recibos), sin reusar la del otro plan', async () => {
    h.S.billingPortal.configurations.list.mockResolvedValue({ data: [{ id: 'bpc_care', metadata: { app: 'stryv-care' } }] });
    await invocar(evento({ action: 'portal', plan: 'grow' }));
    expect(h.S.billingPortal.configurations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        business_profile: { headline: 'STRYV Grow · videos con IA para tus redes' },
        features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
        metadata: { app: 'stryv-grow' }
      })
    );
    expect(h.S.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ configuration: 'bpc_new' }));
  });
});

describe('stryv-care · fallos', () => {
  it('Stripe truena → 500 con texto fijo marcado seguro; el detalle se reporta, no viaja', async () => {
    h.S.customers.search.mockRejectedValue(new Error('Invalid API Key provided: sk_live_***'));
    const res = await invocar();
    expect(res.statusCode).toBe(500);
    const b = cuerpo(res);
    expect(b.error).toBe('No pudimos consultar los planes STRYV. Intenta de nuevo.');
    expect(b.seguro).toBe(true);
    expect(res.body).not.toContain('sk_live');
    expect(h.reportar).toHaveBeenCalled();
  });
});

describe('stryv-care · helpers puros', () => {
  it('planDesde: sin valor = Care; solo care|grow', () => {
    expect(planDesde(undefined)).toBe(PLANES.care);
    expect(planDesde('grow')).toBe(PLANES.grow);
    expect(planDesde('premium')).toBeNull();
    expect(planDesde(1)).toBeNull();
  });

  it('suscripcionDelPlan: por metadata.app del plan y solo vivas', () => {
    const subs = [{ status: 'canceled', metadata: { app: 'stryv-care' } }, SUB_GROW, SUB_CARE];
    expect(suscripcionDelPlan(subs, PLANES.care)).toBe(SUB_CARE);
    expect(suscripcionDelPlan(subs, PLANES.grow)).toBe(SUB_GROW);
    expect(suscripcionDelPlan([{ status: 'active', metadata: null }], PLANES.care)).toBeNull();
  });

  it('claveTenant solo acepta slugs seguros', () => {
    expect(claveTenant('ekko')).toBe('ekko');
    expect(claveTenant('pilates-noria_2')).toBe('pilates-noria_2');
    expect(claveTenant("x' OR 1")).toBeNull();
    expect(claveTenant('')).toBeNull();
    expect(claveTenant(null)).toBeNull();
  });

  it('finPeriodo lee los items (API basil) y respalda en el campo viejo', () => {
    expect(finPeriodo({ items: { data: [{ current_period_end: 10 }] }, current_period_end: 5 })).toBe(10);
    expect(finPeriodo({ current_period_end: 5 })).toBe(5);
    expect(finPeriodo({})).toBeNull();
    expect(finPeriodo(null)).toBeNull();
  });

  it('lookupKey depende del plan y del precio: cambiar el precio crea otro Price, no muta el viejo', () => {
    expect(lookupKey(PLANES.care, 250000)).toBe('stryv_care_mxn_mensual_250000');
    expect(lookupKey(PLANES.grow, 650000)).toBe('stryv_grow_mxn_mensual_650000');
    expect(lookupKey(PLANES.care, 400000)).not.toBe(lookupKey(PLANES.care, 250000));
  });
});
