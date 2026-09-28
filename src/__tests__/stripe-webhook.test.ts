import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

/**
 * Webhook de Stripe (PKG-01A): firma, reclamación atómica (claim_stripe_event),
 * máquina de estados durable (procesado | ignorado | error_reintentable |
 * revision), semántica HTTP por estado, diario verificado y dispatch a los RPC
 * activar/sync. Mantiene los mappers reales (`clasificarEvento`) y mockea solo
 * Stripe + DB + Sentry (no-op) + email.
 *
 * Entorno hermético (PKG-00C): el handler lee STRIPE_CONNECT_WEBHOOK_SECRET
 * antes que STRIPE_WEBHOOK_SECRET. Cada escenario fija o borra explícitamente
 * ambas variables y la suite restaura el entorno original.
 */

const ENV_SUITE = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET', 'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const envOriginal: Partial<Record<(typeof ENV_SUITE)[number], string | undefined>> = {};
beforeAll(() => { for (const k of ENV_SUITE) envOriginal[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_SUITE) {
    if (envOriginal[k] === undefined) delete process.env[k];
    else process.env[k] = envOriginal[k];
  }
});

const mockConstructEvent = vi.fn();
const mockSubRetrieve = vi.fn().mockResolvedValue({ current_period_end: 1_700_000_000 });
const mockRpc = vi.fn();            // RPC de NEGOCIO (activar/sync/invitados)
const mockClaim = vi.fn();          // claim_stripe_event
const mockDeleteEq = vi.fn().mockResolvedValue({ error: null });
// tenants: lookup por stripe_account_id (cuenta ajena) + update (account.updated)
const mockTenantMaybeSingle = vi.fn();
const mockTenantUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockTenantUpdate = vi.fn(() => ({ eq: mockTenantUpdateEq }));

// Cadena de query encadenable + thenable (para .select().eq().in().not()… y
// .maybeSingle()). Por defecto resuelve data vacía (sin subs previas ni emails).
function makeChain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'gte']) c[m] = () => c;
  c.maybeSingle = () => Promise.resolve({ data: null, error: null });
  c.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb);
  return c;
}

vi.mock('../../netlify/functions/_lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../netlify/functions/_lib/stripe')>()),
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockSubRetrieve }
  })
}));

const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockUpsertFila = vi.fn();
const mockUpdate = vi.fn();
/** Resultado del UPDATE final de stripe_webhook_events (finalizar). */
let finalizarResultado: () => { data: unknown; error: unknown } = () => ({ data: [{ id: 'evt_1' }], error: null });
/** Resultado del upsert por tabla (payment_events). */
const upsertResultado: Record<string, { data: unknown; error: unknown }> = {};
const filaPorTabla: Record<string, unknown> = {};
const mockAvisarStaff = vi.fn().mockResolvedValue(1);
vi.mock('../../netlify/functions/_lib/avisosStaff', () => ({
  avisarStaff: (...a: unknown[]) => mockAvisarStaff(...a)
}));
const mockEnviarEmail = vi.fn().mockResolvedValue({ sent: true });
vi.mock('../../netlify/functions/_lib/email', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/email')>()),
  enviarEmail: (...a: unknown[]) => mockEnviarEmail(...a)
}));
const mockReportar = vi.fn().mockResolvedValue(undefined);
vi.mock('../../netlify/functions/_lib/sentry', () => ({
  reportarErrorServidor: (...a: unknown[]) => mockReportar(...a)
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (name: string, args: unknown) => (name === 'claim_stripe_event' ? mockClaim(args) : mockRpc(name, args)),
    from: vi.fn((table: string) => {
      if (table === 'tenants') {
        const c = makeChain();
        c.maybeSingle = () => mockTenantMaybeSingle();
        return { select: () => c, update: mockTenantUpdate };
      }
      return {
        upsert: vi.fn((fila: unknown) => {
          mockUpsertFila(table, fila);
          const p = Promise.resolve(upsertResultado[table] ?? { data: null, error: null });
          return Object.assign(p, { select: () => p });
        }),
        delete: vi.fn(() => ({ eq: mockDeleteEq })),
        insert: (fila: unknown) => mockInsert(table, fila),
        // update().eq().eq().select() — finalizar; también awaitable.
        update: (patch: unknown) => {
          mockUpdate(table, patch);
          const u: Record<string, unknown> = {};
          for (const m of ['eq', 'is']) u[m] = () => u;
          u.select = () => Promise.resolve(finalizarResultado());
          u.then = (cb: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(cb);
          return u;
        },
        select: vi.fn(() => {
          const c = makeChain();
          // Fila por tabla para los lookups con .maybeSingle() (default: null).
          if (filaPorTabla[table]) c.maybeSingle = () => Promise.resolve({ data: filaPorTabla[table], error: null });
          return c;
        })
      };
    })
  }))
}));

import { handler } from '../../netlify/functions/stripe-webhook/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(): AnyEvent {
  return {
    httpMethod: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{"raw":true}',
    isBase64Encoded: false
  } as unknown as AnyEvent;
}
async function invocar() {
  return (await handler(evento(), {} as never, () => {})) as { statusCode: number; body: string };
}

/** Última transición escrita en stripe_webhook_events (finalizar). */
const ultimaTransicion = () =>
  mockUpdate.mock.calls.filter((c) => c[0] === 'stripe_webhook_events').map((c) => c[1] as Record<string, unknown>).at(-1);
const claimDevuelve = (resultado: string, extra: Partial<{ estado_previo: string | null; accion_previa: string | null; intentos: number }> = {}) =>
  mockClaim.mockResolvedValue({ data: { resultado, estado_previo: null, accion_previa: null, intentos: 1, ...extra }, error: null });
const claseReportada = (i = 0) => (mockReportar.mock.calls[i]?.[2] as { clase?: string } | undefined)?.clase;

const ACTIVAR = {
  id: 'evt_1', type: 'checkout.session.completed', created: 1700000000, livemode: true, api_version: '2026-04-22.dahlia',
  data: { object: { object: 'checkout.session', id: 'cs_1', payment_status: 'paid', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
};

describe('stripe-webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(filaPorTabla)) delete filaPorTabla[k];
    for (const k of Object.keys(upsertResultado)) delete upsertResultado[k];
    finalizarResultado = () => ({ data: [{ id: 'evt_1' }], error: null });
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET; // el escenario base usa el secret genérico
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockRpc.mockResolvedValue({ data: {}, error: null });
    claimDevuelve('nuevo');
    mockTenantMaybeSingle.mockResolvedValue({ data: { id: 'tenant-1' }, error: null }); // cuenta conocida
  });

  // ── Entrada ────────────────────────────────────────────────────────────────
  it('sin secret → 500 + reporte (antes 200 "skipped": Stripe daba el evento por entregado)', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const res = await invocar();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('stripe_no_configurado');
    expect(mockClaim).not.toHaveBeenCalled();
    expect(claseReportada()).toBe('configuracion');
  });

  it('firma inválida → 400, sin fila ni RPC', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('el claim manda cuenta, livemode, api_version y resumen SIN PII', async () => {
    mockConstructEvent.mockReturnValue({
      ...ACTIVAR, account: 'acct_ekko',
      data: { object: { ...ACTIVAR.data.object, customer_details: { email: 'ana@e.mx', name: 'Ana' } } }
    });
    await invocar();
    const args = mockClaim.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ p_id: 'evt_1', p_type: 'checkout.session.completed', p_stripe_account: 'acct_ekko', p_livemode: true, p_api_version: '2026-04-22.dahlia', p_lease_segundos: 60 });
    expect(args.p_resumen).toMatchObject({ objeto: 'checkout.session', id: 'cs_1', subscription: 'sub_1', customer: 'cus_1', payment_status: 'paid', mode: 'subscription', metadata: { usuario_id: 'u1', tier_id: 't1' } });
    expect(JSON.stringify(args.p_resumen)).not.toMatch(/ana@e\.mx|Ana/);
  });

  it('claim falla (DB caída) → 500, sin negocio (nunca 200 sin fila)', async () => {
    mockConstructEvent.mockReturnValue(ACTIVAR);
    mockClaim.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const res = await invocar();
    expect(res.statusCode).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(claseReportada()).toBe('reintentable');
  });

  // ── Éxito ─────────────────────────────────────────────────────────────────
  it('checkout.session.completed → activar_membresia y fila procesado con motivo', async () => {
    mockConstructEvent.mockReturnValue(ACTIVAR);
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_1', undefined);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: 'sub_1', p_stripe_customer_id: 'cus_1'
    }));
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', accion: 'activar', motivo: 'activado', processed_at: expect.any(String), lease_hasta: null });
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });

  it('checkout mode payment (paquete) → activar sin retrieve de suscripción', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { payment_status: 'paid', mode: 'payment', subscription: null, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockSubRetrieve).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: null, p_periodo_fin: null
    }));
  });

  it('invoice.paid 1ª factura → activar_membresia leyendo metadata de la suscripción', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'invoice.paid', created: 1700000000,
      data: { object: { subscription: 'sub_1', billing_reason: 'subscription_create' } }
    });
    mockSubRetrieve.mockResolvedValue({
      current_period_end: 1700000000, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: 'sub_1'
    }));
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'activado:sub' });
  });

  it('customer.subscription.updated → sync_membresia_stripe, procesado sync:past_due', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000,
      data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: false } }
    });
    mockRpc.mockResolvedValue({ data: { success: true, estado: 'past_due', membresia_id: 'm1' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({
      p_stripe_subscription_id: 'sub_1', p_estado: 'past_due'
    }));
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', accion: 'sync', motivo: 'sync:past_due' });
  });

  it('paquete por Checkout: la sesión y su PaymentIntent mandan la MISMA referencia (idempotencia del pago)', async () => {
    const meta = { usuario_id: 'u1', tier_id: 't1' };
    mockConstructEvent.mockReturnValueOnce({
      id: 'evt_sesion', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { payment_status: 'paid', mode: 'payment', subscription: null, customer: 'cus_1', payment_intent: 'pi_1', metadata: meta } }
    });
    await invocar();
    mockConstructEvent.mockReturnValueOnce({
      id: 'evt_pi', type: 'payment_intent.succeeded', created: 1700000001,
      data: { object: { id: 'pi_1', customer: 'cus_1', amount: 115000, currency: 'mxn', metadata: meta } }
    });
    await invocar();

    const refs = mockRpc.mock.calls
      .filter((c) => c[0] === 'activar_membresia')
      .map((c) => (c[1] as { p_referencia: string | null }).p_referencia);
    expect(refs).toEqual(['pi_1', 'pi_1']);
  });

  it('suscripción: sin referencia (ya es idempotente por subscription_id)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { payment_status: 'paid', mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', payment_intent: null, metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    });
    await invocar();
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({ p_referencia: null }));
  });

  // ── Ignorados explícitos ───────────────────────────────────────────────────
  describe('ignorado explícito (200, fila terminal con motivo)', () => {
    it('evento firmado de tipo desconocido → ignorado evento_no_manejado:<type>, sin RPC', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'price.created', created: 1, data: { object: { id: 'price_1' } } });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('evento_no_manejado:price.created');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'ignorado', motivo: 'evento_no_manejado:price.created', processed_at: expect.any(String) });
    });

    it('objeto con metadata.app de otra app → ignorado app_ajena (fila terminal, no pendiente eterno)', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_1', amount: 1000, customer: 'cus_1', metadata: { app: 'sala', usuario_id: 'u1', tier_id: 't1' } } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('app_ajena');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'ignorado', motivo: 'app_ajena', processed_at: expect.any(String), lease_hasta: null });
    });

    it('si no se puede escribir el ignorado → 500 (no hay 200 sin fila terminal)', async () => {
      mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'price.created', created: 1, data: { object: {} } });
      finalizarResultado = () => ({ data: null, error: { message: 'fetch failed' } });
      const res = await invocar();
      expect(res.statusCode).toBe(500);
    });
  });

  // ── Reclamación / lease / duplicados ───────────────────────────────────────
  describe('claim: duplicados, lease y re-entradas', () => {
    beforeEach(() => mockConstructEvent.mockReturnValue(ACTIVAR));

    it('duplicado (ya procesado) → 200 duplicate, sin RPC ni transición', async () => {
      claimDevuelve('duplicado', { estado_previo: 'procesado', accion_previa: 'activar' });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).duplicate).toBe(true);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('lease vigente (otra entrega lo tiene) → 503, sin negocio', async () => {
      claimDevuelve('en_curso', { estado_previo: 'en_proceso' });
      const res = await invocar();
      expect(res.statusCode).toBe(503);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('lease vencido con acción idempotente (activar) → se reclama y SE PROCESA', async () => {
      claimDevuelve('reclamado', { estado_previo: 'en_proceso', accion_previa: 'activar', intentos: 2 });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({ p_usuario_id: 'u1' }));
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado' });
    });

    it('lease vencido con invitados-extra (NO idempotente) → revision sin re-ejecutar el RPC', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_1', amount: 20000, currency: 'mxn', metadata: { app: 'ekko', tipo: 'invitados_extra', reserva_id: 'r1', cantidad: '2', usuario_id: 'u1' } } }
      });
      claimDevuelve('reclamado', { estado_previo: 'en_proceso', accion_previa: 'invitados-extra', intentos: 2 });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).revision).toBe('reentrada_sobre_efecto_no_idempotente');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpsertFila).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', accion: 'invitados-extra', motivo: 'reentrada_sobre_efecto_no_idempotente', ultimo_error: expect.stringMatching(/intento 2/) });
      expect(claseReportada()).toBe('revision');
    });

    it('primera entrega de invitados-extra → sí ejecuta registrar_invitados_extra_pagados', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_1', amount: 20000, currency: 'mxn', metadata: { app: 'ekko', tipo: 'invitados_extra', reserva_id: 'r1', cantidad: '2', usuario_id: 'u1' } } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('registrar_invitados_extra_pagados', { p_reserva_id: 'r1', p_cantidad: 2 });
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'invitados_extra:sumados' });
    });

    it('re-entrega desde revision (humano corrigió y reenvió desde Stripe) → se procesa', async () => {
      claimDevuelve('reclamado', { estado_previo: 'revision', accion_previa: 'activar', intentos: 3 });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.anything());
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado' });
    });

    it('reintento desde error_reintentable → se procesa', async () => {
      claimDevuelve('reclamado', { estado_previo: 'error_reintentable', accion_previa: 'activar', intentos: 2 });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado' });
    });
  });

  // ── Fallos ────────────────────────────────────────────────────────────────
  describe('fallos: transitorio → error_reintentable (5xx); permanente → revision (200); nunca DELETE', () => {
    beforeEach(() => mockConstructEvent.mockReturnValue(ACTIVAR));

    it('RPC con error transitorio → error_reintentable + 500 + ultimo_error, la fila NO se borra', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'fetch failed', code: 'PGRST301' } });
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(mockDeleteEq).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'error_reintentable', accion: 'activar', ultimo_error: expect.stringMatching(/fetch failed/), processed_at: null });
      expect(claseReportada()).toBe('reintentable');
    });

    it('Stripe no responde (StripeConnectionError en retrieve) → error_reintentable + 500', async () => {
      mockSubRetrieve.mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { type: 'StripeConnectionError' }));
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(ultimaTransicion()).toMatchObject({ estado: 'error_reintentable' });
    });

    it('RPC con excepción de negocio (EKKO_TIER_INVALIDO) → revision + 200 + aviso al staff + reporte', async () => {
      mockConstructEvent.mockReturnValue({ ...ACTIVAR, account: 'acct_ekko' });
      mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo', code: 'P0001' } });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).revision).toBe('error_permanente');
      expect(mockDeleteEq).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', motivo: 'error_permanente', ultimo_error: expect.stringMatching(/EKKO_TIER_INVALIDO/), processed_at: null });
      expect(mockReportar).toHaveBeenCalledWith('stripe-webhook', expect.any(Error), expect.objectContaining({ clase: 'revision', event_id: 'evt_1' }));
      expect(mockAvisarStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenant_id: 'tenant-1', tipo: 'stripe_revision', soloAdmins: true, metadata: expect.objectContaining({ event_id: 'evt_1' }) }));
    });

    it('Stripe: suscripción inexistente (StripeInvalidRequestError) → revision', async () => {
      mockSubRetrieve.mockRejectedValueOnce(Object.assign(new Error('No such subscription'), { type: 'StripeInvalidRequestError' }));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision' });
    });

    it('intentos agotados (8) con error transitorio → revision intentos_agotados + 200', async () => {
      claimDevuelve('reclamado', { estado_previo: 'error_reintentable', accion_previa: 'activar', intentos: 8 });
      mockRpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', motivo: 'intentos_agotados', ultimo_error: expect.stringMatching(/fetch failed/) });
    });

    it('intento 7 con error transitorio → todavía error_reintentable', async () => {
      claimDevuelve('reclamado', { estado_previo: 'error_reintentable', accion_previa: 'activar', intentos: 7 });
      mockRpc.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(ultimaTransicion()).toMatchObject({ estado: 'error_reintentable' });
    });

    it('fallo al escribir la transición final "procesado" → 500 (no hay éxito silencioso)', async () => {
      finalizarResultado = () => ({ data: null, error: { message: 'fetch failed' } });
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.anything());
    });

    it('la transición final no afecta filas (otro intento se la llevó) → 500', async () => {
      finalizarResultado = () => ({ data: [], error: null });
      const res = await invocar();
      expect(res.statusCode).toBe(500);
    });

    it('fallo al registrar la revision → 500 (Stripe reintenta; sin fila revision no hay 200)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado', code: 'P0001' } });
      finalizarResultado = () => ({ data: null, error: { message: 'fetch failed' } });
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(mockAvisarStaff).not.toHaveBeenCalled();
    });
  });

  // ── Divergencias (dinero/derecho de EKKO sin entidad) ─────────────────────
  describe('divergencias → revision con evidencia (no éxito silencioso, no membresía inventada)', () => {
    it('PKG-01B · subscription.updated → activa SIN membresía (invoice.paid aún no llegó) → ignorado sin_membresia:activacion_por_factura, sin revisión ni aviso', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000, account: 'acct_ekko',
        data: { object: { id: 'sub_nueva', status: 'active', cancel_at_period_end: false } }
      });
      mockRpc.mockResolvedValue({ data: { success: false, reason: 'membresia_no_encontrada' }, error: null });

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('sin_membresia:activacion_por_factura');
      expect(ultimaTransicion()).toMatchObject({ estado: 'ignorado', accion: 'sync', motivo: 'sin_membresia:activacion_por_factura', processed_at: expect.any(String) });
      expect(mockRpc).toHaveBeenCalledTimes(1); // solo el sync; no se activa nada
      expect(mockUpsertFila).not.toHaveBeenCalled();
      expect(mockReportar).not.toHaveBeenCalled();
      expect(mockAvisarStaff).not.toHaveBeenCalled();
    });

    it.each([
      ['customer.subscription.updated', { id: 'sub_x', status: 'past_due', cancel_at_period_end: false }, 'past_due'],
      ['customer.subscription.updated', { id: 'sub_x', status: 'active', pause_collection: { behavior: 'void' } }, 'pausada'],
      ['customer.subscription.deleted', { id: 'sub_x', status: 'canceled' }, 'cancelada'],
      ['customer.subscription.updated', { id: 'sub_x', status: 'canceled' }, 'cancelada']
    ])('%s → %s SIN membresía → sigue siendo revision membresia_no_encontrada (la excepción no se generaliza)', async (type, object, estado) => {
      mockConstructEvent.mockReturnValue({ id: 'evt_1', type, created: 1700000000, data: { object } });
      mockRpc.mockResolvedValue({ data: { success: false, reason: 'membresia_no_encontrada' }, error: null });

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).revision).toBe('membresia_no_encontrada');
      expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({ p_estado: estado }));
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', accion: 'sync', motivo: 'membresia_no_encontrada' });
      expect(mockReportar).toHaveBeenCalledWith('stripe-webhook', expect.objectContaining({ message: expect.stringMatching(/membresia_no_encontrada/) }), expect.objectContaining({ clase: 'revision' }));
    });

    it('subscription.updated → activa con otro fallo del sync (no membresia_no_encontrada) → revision', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000,
        data: { object: { id: 'sub_x', status: 'active', cancel_at_period_end: false } }
      });
      mockRpc.mockResolvedValue({ data: { success: false, reason: 'otra_razon' }, error: null });
      const res = await invocar();
      expect(JSON.parse(res.body).revision).toBe('otra_razon');
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision' });
    });

    it('1ª factura pagada de una suscripción SIN metadata → revision suscripcion_sin_metadata (antes: procesado en silencio)', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'invoice.paid', created: 1700000000,
        data: { object: { id: 'in_1', amount_paid: 85000, currency: 'mxn', subscription: 'sub_1', billing_reason: 'subscription_create' } }
      });
      mockSubRetrieve.mockResolvedValue({ current_period_end: 1700000000, customer: 'cus_1', metadata: {} });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpsertFila).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', motivo: 'suscripcion_sin_metadata' });
    });

    it('checkout de EKKO completado sin usuario/plan → revision faltan_datos_en_session, sin RPC', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
        data: { object: { payment_status: 'paid', mode: 'payment', customer: 'cus_1', metadata: {} } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).revision).toBe('faltan_datos_en_session');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', accion: 'revision', motivo: 'faltan_datos_en_session' });
    });
  });

  // ── Diario de cobranza verificado ──────────────────────────────────────────
  describe('payment_events (diario) verificado', () => {
    const pagoPaquete = {
      id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
      data: { object: { id: 'pi_9', customer: 'cus_1', amount: 199000, currency: 'mxn', receipt_email: 'ana@e.mx', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } } }
    };

    it('éxito: el diario se escribe ANTES de procesado y raw_payload va redactado', async () => {
      mockConstructEvent.mockReturnValue(pagoPaquete);
      filaPorTabla.usuarios = { email: null, nombre: 'Ana', tenant_id: 't1' };
      await invocar();
      const idxDiario = mockUpsertFila.mock.calls.findIndex((c) => c[0] === 'payment_events');
      expect(idxDiario).toBeGreaterThanOrEqual(0);
      const fila = mockUpsertFila.mock.calls[idxDiario][1] as { raw_payload: { data: { object: Record<string, unknown> } } };
      expect(fila.raw_payload.data.object.receipt_email).toBe('[redactado]');
      expect(fila.raw_payload.data.object.id).toBe('pi_9');
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado' });
    });

    it('si el diario falla → NO procesado: error_reintentable + 500 (la re-entrada es idempotente)', async () => {
      mockConstructEvent.mockReturnValue(pagoPaquete);
      upsertResultado.payment_events = { data: null, error: { message: 'fetch failed' } };
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(ultimaTransicion()).toMatchObject({ estado: 'error_reintentable', ultimo_error: expect.stringMatching(/payment_events\.upsert/) });
      expect(mockEnviarEmail).not.toHaveBeenCalled();
    });

    it('un fallo de aviso/correo después de procesado NO cambia la respuesta ni el estado', async () => {
      mockConstructEvent.mockReturnValue(pagoPaquete);
      filaPorTabla.usuarios = { email: 'ana@e.mx', nombre: 'Ana', tenant_id: 't1' };
      mockEnviarEmail.mockRejectedValueOnce(new Error('resend caído'));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado' });
    });
  });

  describe('avisos', () => {
    const pagoFallido = {
      id: 'evt_1', type: 'invoice.payment_failed', created: 1700000000,
      data: { object: { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', amount_due: 85000, currency: 'mxn' } }
    };
    beforeEach(() => mockRpc.mockResolvedValue({ data: { success: true, estado: 'past_due', membresia_id: 'mem_1' }, error: null }));

    it('pago fallido SIN email del miembro: igual deja el aviso in-app y avisa al equipo', async () => {
      mockConstructEvent.mockReturnValue(pagoFallido);
      filaPorTabla.membresias = { usuario_id: 'u1', tenant_id: 't1' };
      filaPorTabla.usuarios = { email: null, nombre: 'Ana' };

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      const aviso = mockInsert.mock.calls.find((c) => c[0] === 'notificaciones')?.[1] as Record<string, unknown>;
      expect(aviso).toMatchObject({ usuario_id: 'u1', tenant_id: 't1', tipo: 'pago_rechazado' });
      // Sin push_enviado_at: cron-push lo lleva al teléfono.
      expect(aviso).not.toHaveProperty('push_enviado_at');
      expect(mockAvisarStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tipo: 'cobro_rechazado', tenant_id: 't1' }));
      expect(mockEnviarEmail).not.toHaveBeenCalled();
    });

    it('pago fallido CON email: además manda el correo', async () => {
      mockConstructEvent.mockReturnValue(pagoFallido);
      filaPorTabla.membresias = { usuario_id: 'u1', tenant_id: 't1' };
      filaPorTabla.usuarios = { email: 'ana@e.mx', nombre: 'Ana' };
      await invocar();
      expect(mockEnviarEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@e.mx' }));
      expect(mockAvisarStaff).toHaveBeenCalledTimes(1);
    });

    it('compra de paquete: correo de confirmación con saldo y vigencia', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_9', customer: 'cus_1', amount: 199000, currency: 'mxn', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, creditos: 12, periodo_fin: '2027-01-18T12:00:00Z' }, error: null });
      filaPorTabla.usuarios = { email: 'ana@e.mx', nombre: 'Ana', tenant_id: 't1' };

      await invocar();

      const correo = mockEnviarEmail.mock.calls[0]?.[0] as { subject: string; html: string };
      expect(correo.subject).toMatch(/paquete/i);
      expect(correo.html).toMatch(/12 créditos/);
      expect(correo.html).toMatch(/18 de enero de 2027/);
    });

    it('segundo evento del MISMO pago (idempotente): no se manda otro correo y queda activado:idempotente', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_9', customer: 'cus_1', amount: 199000, currency: 'mxn', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, idempotente: true }, error: null });
      filaPorTabla.usuarios = { email: 'ana@e.mx', nombre: 'Ana', tenant_id: 't1' };
      await invocar();
      expect(mockEnviarEmail).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'activado:idempotente' });
    });
  });

  describe('Connect · cuenta compartida', () => {
    const evConCuenta = (account: string) => ({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000, account,
      data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: false, metadata: { app: 'ekko' } } }
    });

    it('evento de una cuenta conectada de EKKO → se procesa sobre esa cuenta', async () => {
      mockConstructEvent.mockReturnValue(evConCuenta('acct_ekko'));
      mockRpc.mockResolvedValue({ data: { success: true, estado: 'past_due' }, error: null });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({ p_stripe_subscription_id: 'sub_1' }));
    });

    it('evento de una cuenta que NO es de ningún estudio (gym de SALA) → 200 ignorado, sin claim ni RPC', async () => {
      mockTenantMaybeSingle.mockResolvedValue({ data: null, error: null });
      mockConstructEvent.mockReturnValue(evConCuenta('acct_sala'));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('cuenta_ajena');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it('no se puede resolver la cuenta (DB) → 500, sin claim', async () => {
      mockTenantMaybeSingle.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
      mockConstructEvent.mockReturnValue(evConCuenta('acct_ekko'));
      const res = await invocar();
      expect(res.statusCode).toBe(500);
      expect(mockClaim).not.toHaveBeenCalled();
    });

    it('account.updated → refresca stripe_charges_enabled/details_submitted del tenant', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'account.updated', created: 1700000000, account: 'acct_ekko',
        data: { object: { id: 'acct_ekko', charges_enabled: true, details_submitted: true, payouts_enabled: true } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockTenantUpdate).toHaveBeenCalledWith({ stripe_charges_enabled: true, stripe_details_submitted: true });
      expect(mockTenantUpdateEq).toHaveBeenCalledWith('stripe_account_id', 'acct_ekko');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'cuenta:actualizada' });
    });
  });

  // ── F2 · R1: atribución determinista de payment_events y conflictos ─────────
  describe('R1 · atribución y conflictos (sin cambio de semántica)', () => {
    const pagoRegistrado = () =>
      mockUpsertFila.mock.calls.find((c) => c[0] === 'payment_events')?.[1] as Record<string, unknown> | undefined;

    it('renovación dahlia (parent.subscription_details) → sync de ESA suscripción y pago atribuido a membresía, usuario y tenant', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_b1', type: 'invoice.paid', created: 1700000000,
        data: { object: {
          id: 'in_b1', amount_paid: 85000, currency: 'mxn', customer: 'cus_7', billing_reason: 'subscription_cycle',
          customer_email: 'ana@e.mx', customer_name: 'Ana',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_b1', metadata: {} } },
          payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_b1' } }] }
        } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, estado: 'activa', membresia_id: 'mem_1' }, error: null });
      filaPorTabla.membresias = { id: 'mem_1', usuario_id: 'u1', tenant_id: 't1' };
      filaPorTabla.usuarios = { email: null, nombre: 'Ana' };

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({ p_stripe_subscription_id: 'sub_b1', p_estado: 'activa' }));
      expect(pagoRegistrado()).toMatchObject({
        usuario_id: 'u1', tenant_id: 't1', membresia_id: 'mem_1',
        stripe_subscription_id: 'sub_b1', stripe_payment_intent_id: 'pi_b1', status: 'succeeded'
      });
      expect((pagoRegistrado()!.raw_payload as { data: { object: Record<string, unknown> } }).data.object.customer_email).toBe('[redactado]');
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'sync:activa' });
    });

    it('pago fallido dahlia → el miembro y el equipo SÍ reciben el aviso', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_b2', type: 'invoice.payment_failed', created: 1700000000,
        data: { object: { id: 'in_b2', amount_due: 85000, currency: 'mxn', customer: 'cus_7', parent: { subscription_details: { subscription: 'sub_b1' } } } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, estado: 'past_due', membresia_id: 'mem_1' }, error: null });
      filaPorTabla.membresias = { id: 'mem_1', usuario_id: 'u1', tenant_id: 't1' };
      filaPorTabla.usuarios = { email: null, nombre: 'Ana' };

      await invocar();

      expect(pagoRegistrado()).toMatchObject({ usuario_id: 'u1', membresia_id: 'mem_1', status: 'failed' });
      const aviso = mockInsert.mock.calls.find((c) => c[0] === 'notificaciones')?.[1];
      expect(aviso).toMatchObject({ usuario_id: 'u1', tipo: 'pago_rechazado' });
    });

    it('renovación de una suscripción sin membresía local → revision (divergencia), NO pago sin atribuir', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_b3', type: 'invoice.paid', created: 1700000000,
        data: { object: { id: 'in_b3', amount_paid: 1000, currency: 'mxn', customer: 'cus_x', billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: 'sub_desconocida' } } } }
      });
      mockRpc.mockResolvedValue({ data: { success: false, reason: 'membresia_no_encontrada' }, error: null });

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(pagoRegistrado()).toBeUndefined();
      expect(ultimaTransicion()).toMatchObject({ estado: 'revision', motivo: 'membresia_no_encontrada' });
    });

    it('evento de OTRA app (HOGAR) → no toca membresías ni registra el pago', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_h', type: 'invoice.paid', created: 1700000000,
        data: { object: { id: 'in_h', amount_paid: 1000, currency: 'mxn', parent: { subscription_details: { subscription: 'sub_h', metadata: { app: 'hogar' } } } } }
      });

      const res = await invocar();

      expect(JSON.parse(res.body)).toMatchObject({ ignored: 'app_ajena' });
      expect(mockRpc).not.toHaveBeenCalled();
      expect(pagoRegistrado()).toBeUndefined();
    });

    it('paquete de EKKO (PaymentIntent dahlia, sin `invoice`) → el pago lleva la membresía que creó activar_membresia', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_p', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_p', customer: 'cus_1', amount: 25000, currency: 'mxn', latest_charge: 'ch_p', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, membresia_id: 'mem_nueva', creditos: 1 }, error: null });
      filaPorTabla.usuarios = { email: null, nombre: 'Ana', tenant_id: 't1' };

      await invocar();

      expect(pagoRegistrado()).toMatchObject({ usuario_id: 'u1', tenant_id: 't1', membresia_id: 'mem_nueva' });
    });

    it('estado contradictorio (Stripe viva sobre membresía terminal) → procesado sync:conflicto, 200, reportado como invariante', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_c', type: 'invoice.paid', created: 1700000000,
        data: { object: { id: 'in_c', amount_paid: 85000, currency: 'mxn', billing_reason: 'subscription_cycle', subscription: 'sub_c' } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, ignorado: 'membresia_terminal', conflicto: true, membresia_id: 'mem_c' }, error: null });

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(mockDeleteEq).not.toHaveBeenCalled(); // no se libera el evento para reintento
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'sync:conflicto' });
      expect(mockReportar).toHaveBeenCalledWith(
        'stripe-webhook',
        expect.objectContaining({ message: expect.stringMatching(/contradictorio/) }),
        expect.objectContaining({ membresia_id: 'mem_c', clase: 'invariante' })
      );
    });

    it('evento viejo (guardia de orden R1: skipped) → procesado sync:evento_viejo, sin revisión', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_v', type: 'customer.subscription.updated', created: 1600000000,
        data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: false } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, skipped: 'evento_viejo' }, error: null });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'sync:evento_viejo' });
      expect(mockReportar).not.toHaveBeenCalled();
    });
  });
});

// ── PKG-01B · Checkout solo activa si está pagado (C17) ─────────────────────
describe('PKG-01B · checkout.session.completed: NO FINANCIAL SUCCESS → NO ENTITLEMENT SUCCESS', () => {
  const META = { app: 'ekko', usuario_id: 'u1', tier_id: 't1' };
  const sesion = (id: string, over: Record<string, unknown> = {}) => ({
    id, type: 'checkout.session.completed', created: 1700000000, livemode: true, api_version: '2026-04-22.dahlia', account: 'acct_ekko',
    data: { object: { object: 'checkout.session', id: 'cs_1', status: 'complete', mode: 'payment', payment_status: 'paid', customer: 'cus_1', payment_intent: 'pi_1', subscription: null, amount_total: 25000, currency: 'mxn', metadata: META, ...over } }
  });
  const piSucceeded = (id: string) => ({
    id, type: 'payment_intent.succeeded', created: 1700000001, livemode: true, account: 'acct_ekko',
    data: { object: { object: 'payment_intent', id: 'pi_1', customer: 'cus_1', amount: 25000, currency: 'mxn', status: 'succeeded', metadata: META } }
  });
  const facturaAlta = (id: string) => ({
    id, type: 'invoice.paid', created: 1700000002, livemode: true, account: 'acct_ekko',
    data: { object: { object: 'invoice', id: 'in_1', amount_paid: 85000, currency: 'mxn', customer: 'cus_1', billing_reason: 'subscription_create', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: META } } } }
  });
  const activaciones = () => mockRpc.mock.calls.filter((c) => c[0] === 'activar_membresia');

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(filaPorTabla)) delete filaPorTabla[k];
    for (const k of Object.keys(upsertResultado)) delete upsertResultado[k];
    finalizarResultado = () => ({ data: [{ id: 'evt' }], error: null });
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockRpc.mockResolvedValue({ data: { success: true, membresia_id: 'mem_1', creditos: 1 }, error: null });
    claimDevuelve('nuevo');
    mockTenantMaybeSingle.mockResolvedValue({ data: { id: 'tenant-1' }, error: null });
    mockSubRetrieve.mockResolvedValue({ current_period_end: 1_700_000_000, customer: 'cus_1', metadata: META });
  });

  it('1 · payment + paid → activar_membresia (ref = PI) por el camino de siempre → procesado activado', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs'));
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({ p_usuario_id: 'u1', p_tier_id: 't1', p_referencia: 'pi_1', p_stripe_subscription_id: null }));
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', accion: 'activar', motivo: 'activado' });
  });

  it('2 · payment + unpaid → ignorado checkout_sin_pagar:payment: sin RPC, sin diario, sin aviso, 200', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs', { payment_status: 'unpaid' }));
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ignored).toBe('checkout_sin_pagar:payment');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpsertFila).not.toHaveBeenCalled();
    expect(mockAvisarStaff).not.toHaveBeenCalled();
    expect(mockReportar).not.toHaveBeenCalled();
    expect(ultimaTransicion()).toMatchObject({ estado: 'ignorado', accion: 'ignore', motivo: 'checkout_sin_pagar:payment', processed_at: expect.any(String) });
    // El claim guardó la evidencia: payment_status en el resumen.
    expect((mockClaim.mock.calls[0][0] as { p_resumen: Record<string, unknown> }).p_resumen).toMatchObject({ payment_status: 'unpaid', payment_intent: 'pi_1' });
  });

  it('3 · unpaid seguido de payment_intent.succeeded del MISMO PI → activa por el PI con referencia pi_1 y registra el diario', async () => {
    mockConstructEvent.mockReturnValueOnce(sesion('evt_cs', { payment_status: 'unpaid' }));
    await invocar();
    expect(activaciones()).toHaveLength(0);
    mockConstructEvent.mockReturnValueOnce(piSucceeded('evt_pi'));
    filaPorTabla.usuarios = { email: null, nombre: 'Ana', tenant_id: 't1' };
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(activaciones()).toHaveLength(1);
    expect(activaciones()[0][1]).toMatchObject({ p_referencia: 'pi_1', p_usuario_id: 'u1' });
    expect(mockUpsertFila.mock.calls.find((c) => c[0] === 'payment_events')?.[1]).toMatchObject({ stripe_event_id: 'evt_pi', stripe_payment_intent_id: 'pi_1', status: 'succeeded' });
  });

  it('4 · no_payment_required → revision checkout_sin_cobro_requerido: sin RPC, aviso al staff y reporte', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs', { payment_status: 'no_payment_required' }));
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).revision).toBe('checkout_sin_cobro_requerido');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(ultimaTransicion()).toMatchObject({ estado: 'revision', accion: 'revision', motivo: 'checkout_sin_cobro_requerido' });
    expect(mockAvisarStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tipo: 'stripe_revision', tenant_id: 'tenant-1' }));
    expect(mockReportar).toHaveBeenCalledWith('stripe-webhook', expect.any(Error), expect.objectContaining({ clase: 'revision' }));
  });

  it('5/6 · payment_status desconocido o ausente → revision checkout_payment_status_desconocido, sin RPC', async () => {
    mockConstructEvent.mockReturnValueOnce(sesion('evt_a', { payment_status: 'pending' }));
    expect(JSON.parse((await invocar()).body).revision).toBe('checkout_payment_status_desconocido');
    const sin = sesion('evt_b'); delete (sin.data.object as Record<string, unknown>).payment_status;
    mockConstructEvent.mockReturnValueOnce(sin);
    expect(JSON.parse((await invocar()).body).revision).toBe('checkout_payment_status_desconocido');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('7 · paid + metadata incompleta → revision faltan_datos_en_session (01A), sin RPC', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs', { metadata: { app: 'ekko' } }));
    const res = await invocar();
    expect(JSON.parse(res.body).revision).toBe('faltan_datos_en_session');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('8 · otra app → ignorado app_ajena sin entitlement, aunque venga paid', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs', { metadata: { app: 'sala', usuario_id: 'u1', tier_id: 't1' } }));
    const res = await invocar();
    expect(JSON.parse(res.body).ignored).toBe('app_ajena');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('9 · subscription + paid → activar_membresia por subscription_id (lee la sub para el periodo)', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs', { mode: 'subscription', subscription: 'sub_1', payment_intent: null }));
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_1', { stripeAccount: 'acct_ekko' });
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({ p_stripe_subscription_id: 'sub_1', p_referencia: null }));
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'activado' });
  });

  it('10 · subscription + unpaid → ignorado checkout_sin_pagar:subscription, sin RPC ni retrieve', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs', { mode: 'subscription', subscription: 'sub_1', payment_intent: null, payment_status: 'unpaid' }));
    const res = await invocar();
    expect(JSON.parse(res.body).ignored).toBe('checkout_sin_pagar:subscription');
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSubRetrieve).not.toHaveBeenCalled();
  });

  it('11 · unpaid subscription seguido de invoice.paid subscription_create → activa por la factura (activar-sub)', async () => {
    mockConstructEvent.mockReturnValueOnce(sesion('evt_cs', { mode: 'subscription', subscription: 'sub_1', payment_intent: null, payment_status: 'unpaid' }));
    await invocar();
    expect(activaciones()).toHaveLength(0);
    mockConstructEvent.mockReturnValueOnce(facturaAlta('evt_inv'));
    filaPorTabla.usuarios = { email: null, nombre: 'Ana', tenant_id: 't1' };
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(activaciones()).toHaveLength(1);
    expect(activaciones()[0][1]).toMatchObject({ p_stripe_subscription_id: 'sub_1', p_usuario_id: 'u1', p_tier_id: 't1' });
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'activado:sub' });
  });

  it('12 · paid + payment_intent.succeeded del mismo pago → dos llamadas con la MISMA referencia; la segunda es idempotente (sin segundo correo)', async () => {
    mockConstructEvent.mockReturnValueOnce(sesion('evt_cs'));
    await invocar();
    mockRpc.mockResolvedValueOnce({ data: { success: true, membresia_id: 'mem_1', idempotente: true }, error: null });
    mockConstructEvent.mockReturnValueOnce(piSucceeded('evt_pi'));
    filaPorTabla.usuarios = { email: 'ana@e.mx', nombre: 'Ana', tenant_id: 't1' };
    await invocar();
    expect(activaciones().map((c) => (c[1] as { p_referencia: string }).p_referencia)).toEqual(['pi_1', 'pi_1']);
    expect(mockEnviarEmail).not.toHaveBeenCalled();
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'activado:idempotente' });
  });

  it('13 · paid subscription + invoice.paid subscription_create → misma subscription_id; la segunda es idempotente', async () => {
    mockConstructEvent.mockReturnValueOnce(sesion('evt_cs', { mode: 'subscription', subscription: 'sub_1', payment_intent: null }));
    await invocar();
    mockRpc.mockResolvedValueOnce({ data: { success: true, membresia_id: 'mem_1', idempotente: true }, error: null });
    mockConstructEvent.mockReturnValueOnce(facturaAlta('evt_inv'));
    await invocar();
    expect(activaciones().map((c) => (c[1] as { p_stripe_subscription_id: string }).p_stripe_subscription_id)).toEqual(['sub_1', 'sub_1']);
    expect(ultimaTransicion()).toMatchObject({ estado: 'procesado', motivo: 'activado:sub' });
  });

  it('14 · mismo event.id entregado dos veces → duplicado (01A), sin segunda activación', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs'));
    await invocar();
    claimDevuelve('duplicado', { estado_previo: 'procesado', accion_previa: 'activar' });
    const res = await invocar();
    expect(JSON.parse(res.body).duplicate).toBe(true);
    expect(activaciones()).toHaveLength(1);
  });

  it('15/16 · async_payment_succeeded / async_payment_failed (no soportados) → ignorado evento_no_manejado, jamás entitlement', async () => {
    for (const type of ['checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed']) {
      mockConstructEvent.mockReturnValueOnce({ ...sesion(`evt_${type}`), type });
      const res = await invocar();
      expect(JSON.parse(res.body).ignored).toBe(`evento_no_manejado:${type}`);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('17/18 · payment_intent.processing / payment_failed → ignorado evento_no_manejado, sin entitlement', async () => {
    for (const type of ['payment_intent.processing', 'payment_intent.payment_failed']) {
      mockConstructEvent.mockReturnValueOnce({ ...piSucceeded(`evt_${type}`), type });
      const res = await invocar();
      expect(JSON.parse(res.body).ignored).toBe(`evento_no_manejado:${type}`);
    }
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpsertFila).not.toHaveBeenCalled();
  });

  it('24 · diario: la sesión paid NO escribe payment_events (lo hace el PI); el handler nunca escribe membresias directo', async () => {
    mockConstructEvent.mockReturnValue(sesion('evt_cs'));
    await invocar();
    expect(mockUpsertFila.mock.calls.find((c) => c[0] === 'payment_events')).toBeUndefined();
    expect(mockInsert.mock.calls.find((c) => c[0] === 'membresias')).toBeUndefined();
    expect(mockUpdate.mock.calls.find((c) => c[0] === 'membresias')).toBeUndefined();
  });
});
