import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Webhook de Stripe: firma, idempotencia (dedupe por event.id + borrado en
 * error para forzar reintento) y dispatch a los RPCs activar/sync.
 * Mantiene los mappers reales (`clasificarEvento`) y mockea solo Stripe + DB.
 */

const mockConstructEvent = vi.fn();
const mockSubRetrieve = vi.fn().mockResolvedValue({ current_period_end: 1_700_000_000 });
const mockUpsertSelect = vi.fn();
const mockRpc = vi.fn();
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
let reclamoGanado = true;
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
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      if (table === 'tenants') {
        const c = makeChain();
        c.maybeSingle = () => mockTenantMaybeSingle();
        return { select: () => c, update: mockTenantUpdate };
      }
      return {
        upsert: vi.fn((fila: unknown) => {
          mockUpsertFila(table, fila);
          return { select: mockUpsertSelect };
        }),
        delete: vi.fn(() => ({ eq: mockDeleteEq })),
        insert: (fila: unknown) => mockInsert(table, fila),
        // update().eq()…  — awaitable (marca processed_at) y con .select() (reclamo).
        update: (patch: unknown) => {
          mockUpdate(table, patch);
          const u: Record<string, unknown> = {};
          for (const m of ['eq', 'is']) u[m] = () => u;
          u.select = () => Promise.resolve({ data: reclamoGanado ? [{ id: 'evt_1' }] : [], error: null });
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

describe('stripe-webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(filaPorTabla)) delete filaPorTabla[k];
    reclamoGanado = true;
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockRpc.mockResolvedValue({ data: {}, error: null });
    mockUpsertSelect.mockResolvedValue({ data: [{ id: 'evt_1' }], error: null }); // evento nuevo
    mockTenantMaybeSingle.mockResolvedValue({ data: { id: 'tenant-1' }, error: null }); // cuenta conocida
  });

  it('sin secret → no-op', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await invocar();
    expect(JSON.parse(res.body).skipped).toBe('stripe_no_configurado');
  });

  it('firma inválida → 400', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await invocar();
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('evento duplicado → no reprocesa', async () => {
    mockUpsertSelect.mockResolvedValue({ data: [], error: null }); // ya existía
    mockConstructEvent.mockReturnValue({ id: 'evt_1', type: 'invoice.paid', created: 1, data: { object: { subscription: 'sub_1' } } });
    const res = await invocar();
    expect(JSON.parse(res.body).duplicate).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('checkout.session.completed → activar_membresia', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_1', undefined);
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({
      p_usuario_id: 'u1', p_tier_id: 't1', p_stripe_subscription_id: 'sub_1', p_stripe_customer_id: 'cus_1'
    }));
  });

  it('checkout mode payment (paquete) → activar sin retrieve de suscripción', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { mode: 'payment', subscription: null, customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
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
  });

  it('customer.subscription.updated → sync_membresia_stripe', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000,
      data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: false } }
    });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({
      p_stripe_subscription_id: 'sub_1', p_estado: 'past_due'
    }));
  });

  it('paquete por Checkout: la sesión y su PaymentIntent mandan la MISMA referencia (idempotencia del pago)', async () => {
    const meta = { usuario_id: 'u1', tier_id: 't1' };
    mockConstructEvent.mockReturnValueOnce({
      id: 'evt_sesion', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { mode: 'payment', subscription: null, customer: 'cus_1', payment_intent: 'pi_1', metadata: meta } }
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
      data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', payment_intent: null, metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    });
    await invocar();
    expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({ p_referencia: null }));
  });

  it('sync que no encuentra la membresía (success:false) NO pasa en silencio: 200 + reporte', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000,
      data: { object: { id: 'sub_huerfana', status: 'active', cancel_at_period_end: false } }
    });
    mockRpc.mockResolvedValue({ data: { success: false, reason: 'membresia_no_encontrada' }, error: null });

    const res = await invocar();

    expect(res.statusCode).toBe(200); // reintentar no la haría aparecer
    expect(mockDeleteEq).not.toHaveBeenCalled();
    expect(mockReportar).toHaveBeenCalledTimes(1);
    expect(String((mockReportar.mock.calls[0][1] as Error).message)).toMatch(/membresia_no_encontrada/);
  });

  describe('idempotencia: recibido ≠ procesado', () => {
    const activar = {
      id: 'evt_1', type: 'checkout.session.completed', created: 1700000000,
      data: { object: { mode: 'subscription', subscription: 'sub_1', customer: 'cus_1', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
    };
    const yaExistia = () => mockUpsertSelect.mockResolvedValue({ data: [], error: null });
    const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

    it('evento nuevo: tras la acción de dinero se marca processed_at', async () => {
      mockConstructEvent.mockReturnValue(activar);
      await invocar();
      expect(mockUpdate).toHaveBeenCalledWith('stripe_webhook_events', { processed_at: expect.any(String) });
    });

    it('si la acción FALLA no se marca procesado (y se borra para que Stripe reintente)', async () => {
      mockConstructEvent.mockReturnValue(activar);
      mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
      await invocar();
      expect(mockUpdate).not.toHaveBeenCalledWith('stripe_webhook_events', { processed_at: expect.any(String) });
      expect(mockDeleteEq).toHaveBeenCalledWith('id', 'evt_1');
    });

    it('reintento de un evento YA procesado → duplicate, sin tocar nada', async () => {
      mockConstructEvent.mockReturnValue(activar);
      yaExistia();
      filaPorTabla.stripe_webhook_events = { received_at: hace(300_000), processed_at: hace(299_000) };
      const res = await invocar();
      expect(JSON.parse(res.body)).toMatchObject({ duplicate: true });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('HUÉRFANO (recibido hace 5 min, sin processed_at: la function murió a medias) → se reclama y SE PROCESA', async () => {
      mockConstructEvent.mockReturnValue(activar);
      yaExistia();
      filaPorTabla.stripe_webhook_events = { received_at: hace(300_000), processed_at: null };
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('activar_membresia', expect.objectContaining({ p_usuario_id: 'u1' }));
    });

    it('recibido hace 2 s y sin terminar (otro intento en curso) → 503, no se procesa dos veces', async () => {
      mockConstructEvent.mockReturnValue(activar);
      yaExistia();
      filaPorTabla.stripe_webhook_events = { received_at: hace(2_000), processed_at: null };
      const res = await invocar();
      expect(res.statusCode).toBe(503);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('dos reintentos reclaman el mismo huérfano: el que pierde el UPDATE condicionado no procesa', async () => {
      mockConstructEvent.mockReturnValue(activar);
      yaExistia();
      filaPorTabla.stripe_webhook_events = { received_at: hace(300_000), processed_at: null };
      reclamoGanado = false;
      const res = await invocar();
      expect(res.statusCode).toBe(503);
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });

  describe('avisos', () => {
    const pagoFallido = {
      id: 'evt_1', type: 'invoice.payment_failed', created: 1700000000,
      data: { object: { id: 'in_1', subscription: 'sub_1', customer: 'cus_1', amount_due: 85000, currency: 'mxn' } }
    };

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

    it('segundo evento del MISMO pago (idempotente): no se manda otro correo', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_9', customer: 'cus_1', amount: 199000, currency: 'mxn', metadata: { usuario_id: 'u1', tier_id: 't1' } } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, idempotente: true }, error: null });
      filaPorTabla.usuarios = { email: 'ana@e.mx', nombre: 'Ana', tenant_id: 't1' };
      await invocar();
      expect(mockEnviarEmail).not.toHaveBeenCalled();
    });
  });

  it('si el RPC falla → borra idempotencia y 500 (para que Stripe reintente)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_1', type: 'invoice.paid', created: 1, data: { object: { subscription: 'sub_1' } }
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await invocar();
    expect(res.statusCode).toBe(500);
    expect(mockDeleteEq).toHaveBeenCalledWith('id', 'evt_1');
  });

  describe('Connect · cuenta compartida', () => {
    const evConCuenta = (account: string) => ({
      id: 'evt_1', type: 'customer.subscription.updated', created: 1700000000, account,
      data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: false, metadata: { app: 'ekko' } } }
    });

    it('evento de una cuenta conectada de EKKO → se procesa sobre esa cuenta', async () => {
      mockConstructEvent.mockReturnValue(evConCuenta('acct_ekko'));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({ p_stripe_subscription_id: 'sub_1' }));
    });

    it('evento de una cuenta que NO es de ningún estudio (gym de SALA) → 200 ignorado, sin RPC ni idempotencia', async () => {
      mockTenantMaybeSingle.mockResolvedValue({ data: null, error: null });
      mockConstructEvent.mockReturnValue(evConCuenta('acct_sala'));
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('cuenta_ajena');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockUpsertSelect).not.toHaveBeenCalled();
    });

    it('objeto con metadata.app de otra app → 200 ignorado (app_ajena), sin RPC', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_1', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_1', amount: 1000, customer: 'cus_1', metadata: { app: 'sala', usuario_id: 'u1', tier_id: 't1' } } }
      });
      const res = await invocar();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ignored).toBe('app_ajena');
      expect(mockRpc).not.toHaveBeenCalled();
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
    });
  });

  // ── F2 · R1: atribución determinista de payment_events y conflictos ─────────
  describe('R1 · atribución y conflictos', () => {
    const pagoRegistrado = () =>
      mockUpsertFila.mock.calls.find((c) => c[0] === 'payment_events')?.[1] as Record<string, unknown> | undefined;

    it('renovación basil (parent.subscription_details) → sync de ESA suscripción y pago atribuido a membresía, usuario y tenant', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_b1', type: 'invoice.paid', created: 1700000000,
        data: { object: {
          id: 'in_b1', amount_paid: 85000, currency: 'mxn', customer: 'cus_7', billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: 'sub_b1', metadata: {} } },
          payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_b1' } }] }
        } }
      });
      filaPorTabla.membresias = { id: 'mem_1', usuario_id: 'u1', tenant_id: 't1' };
      filaPorTabla.usuarios = { email: null, nombre: 'Ana' };

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(mockRpc).toHaveBeenCalledWith('sync_membresia_stripe', expect.objectContaining({ p_stripe_subscription_id: 'sub_b1', p_estado: 'activa' }));
      expect(pagoRegistrado()).toMatchObject({
        usuario_id: 'u1', tenant_id: 't1', membresia_id: 'mem_1',
        stripe_subscription_id: 'sub_b1', stripe_payment_intent_id: 'pi_b1', status: 'succeeded'
      });
    });

    it('pago fallido basil → el miembro y el equipo SÍ reciben el aviso (antes el usuario no se resolvía)', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_b2', type: 'invoice.payment_failed', created: 1700000000,
        data: { object: { id: 'in_b2', amount_due: 85000, currency: 'mxn', customer: 'cus_7', parent: { subscription_details: { subscription: 'sub_b1' } } } }
      });
      filaPorTabla.membresias = { id: 'mem_1', usuario_id: 'u1', tenant_id: 't1' };
      filaPorTabla.usuarios = { email: null, nombre: 'Ana' };

      await invocar();

      expect(pagoRegistrado()).toMatchObject({ usuario_id: 'u1', membresia_id: 'mem_1', status: 'failed' });
      const aviso = mockInsert.mock.calls.find((c) => c[0] === 'notificaciones')?.[1];
      expect(aviso).toMatchObject({ usuario_id: 'u1', tipo: 'pago_rechazado' });
    });

    it('suscripción que no es de EKKO (sin membresía) → pago sin atribuir: no se adivina', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_b3', type: 'invoice.paid', created: 1700000000,
        data: { object: { id: 'in_b3', amount_paid: 1000, currency: 'mxn', customer: 'cus_x', billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: 'sub_desconocida' } } } }
      });
      mockRpc.mockResolvedValue({ data: { success: false, reason: 'membresia_no_encontrada' }, error: null });

      await invocar();

      expect(pagoRegistrado()).toMatchObject({ usuario_id: null, tenant_id: null, membresia_id: null });
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

    it('paquete de EKKO → el pago lleva la membresía que creó activar_membresia', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_p', type: 'payment_intent.succeeded', created: 1700000000,
        data: { object: { id: 'pi_p', customer: 'cus_1', amount: 25000, currency: 'mxn', metadata: { app: 'ekko', usuario_id: 'u1', tier_id: 't1' } } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, membresia_id: 'mem_nueva', creditos: 1 }, error: null });
      filaPorTabla.usuarios = { email: null, nombre: 'Ana', tenant_id: 't1' };

      await invocar();

      expect(pagoRegistrado()).toMatchObject({ usuario_id: 'u1', tenant_id: 't1', membresia_id: 'mem_nueva' });
    });

    it('estado contradictorio (Stripe viva sobre membresía terminal) → 200 sin reintento, reportado', async () => {
      mockConstructEvent.mockReturnValue({
        id: 'evt_c', type: 'invoice.paid', created: 1700000000,
        data: { object: { id: 'in_c', amount_paid: 85000, currency: 'mxn', billing_reason: 'subscription_cycle', subscription: 'sub_c' } }
      });
      mockRpc.mockResolvedValue({ data: { success: true, ignorado: 'membresia_terminal', conflicto: true, membresia_id: 'mem_c' }, error: null });

      const res = await invocar();

      expect(res.statusCode).toBe(200);
      expect(mockDeleteEq).not.toHaveBeenCalled(); // no se libera el evento para reintento
      expect(mockReportar).toHaveBeenCalledWith(
        'stripe-webhook',
        expect.objectContaining({ message: expect.stringMatching(/contradictorio/) }),
        expect.objectContaining({ membresia_id: 'mem_c' })
      );
    });
  });
});
