import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crearStripeFalso, type StripeFalso } from './helpers/stripeFalso';

/**
 * PKG-01F · cambiar-plan-suscripcion (mensual → mensual) con Stripe FALSO:
 *   guards (rol, sanción, tenant, destino, membresía, suscripción REAL, reservas),
 *   política financiera (upgrade: always_invoice + error_if_incomplete → sin
 *   cobro no hay tier; downgrade: create_prorations), identidad
 *   (cuenta, usuario, operation_id), recuperación ante respuesta perdida y
 *   transición atómica por `cambiar_tier_membresia` (mockeado aquí; su
 *   comportamiento real está en src/__tests__/db/cambio-de-plan.db.test.ts).
 */

const h = vi.hoisted(() => ({
  stripe: null as unknown as StripeFalso,
  socio: null as Record<string, unknown> | null,
  tier: null as Record<string, unknown> | null,
  mem: null as Record<string, unknown> | null,
  dp: null as Record<string, unknown> | null,
  rpc: vi.fn(),
  resolver: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'auth-m1' } }, error: null })) },
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: vi.fn((table: string) => {
      if (table === 'tiers') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: h.tier, error: null })) })) })) })) };
      }
      if (table === 'membresias') {
        const c: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'not', 'in', 'order', 'limit']) c[m] = () => c;
        c.maybeSingle = async () => ({ data: h.mem, error: null });
        return c;
      }
      if (table === 'usuarios_datos_privados') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: h.dp, error: null })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: h.socio, error: null })) })) })) };
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/stripe')>()),
  getStripe: () => h.stripe
}));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: (...a: unknown[]) => h.resolver(...a)
}));

import { handler } from '../../netlify/functions/cambiar-plan-suscripcion/index';

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OP2 = '9a8b7c6d-5e4f-4a3b-9c1d-0e1f2a3b4c5d';
const SOCIO = { id: 'm1', tenant_id: 't1', rol: 'miembro', status: 'activo', sancionado_at: null };
const ESENCIAL = { id: 'tier-esencial', slug: 'esencial', activo: true, en_venta: true, tenant_id: 't1', nombre: 'Esencial', precio_centavos: 85000, moneda: 'MXN', tipo: 'tiempo' };
const PREMIUM = { id: 'tier-premium', slug: 'premium', activo: true, en_venta: true, tenant_id: 't1', nombre: 'Premium', precio_centavos: 120000, moneda: 'MXN', tipo: 'tiempo' };
const MEM = { id: 'mem1', tier_id: 'tier-esencial', status: 'activa', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_m1' };

const invocar = async (body: Record<string, unknown>) => {
  const r = (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const BODY = { tier: 'premium', operation_id: OP };
const rpcCalls = (nombre: string) => h.rpc.mock.calls.filter((c) => c[0] === nombre);

beforeEach(() => {
  vi.clearAllMocks();
  h.stripe = crearStripeFalso();
  h.stripe.sembrarSuscripcion({ id: 'sub_1', customer: 'cus_m1', unit_amount: 85000, metadata: { usuario_id: 'm1', tier_id: 'tier-esencial', operation_id: 'creacion' } });
  h.socio = { ...SOCIO };
  h.tier = { ...PREMIUM };
  h.mem = { ...MEM };
  h.dp = { stripe_customer_id: 'cus_m1' };
  h.resolver.mockResolvedValue({ accountId: 'acct_1', chargesEnabled: true });
  h.rpc.mockImplementation(async (nombre: string, args: Record<string, unknown>) => {
    if (nombre === 'reservas_incompatibles_con_tier') return { data: [], error: null };
    if (nombre === 'cambiar_tier_membresia') return { data: { success: true, idempotente: false, membresia_id: args.p_membresia_id, tier_anterior: 'esencial', tier: 'premium' }, error: null };
    return { data: null, error: { message: 'rpc inesperado ' + nombre } };
  });
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('autorización y destino (sin tocar Stripe)', () => {
  it('no miembro → 400; sancionado y revocado → 403', async () => {
    h.socio = { ...SOCIO, rol: 'recepcionista' };
    expect((await invocar(BODY)).status).toBe(400);
    h.socio = { ...SOCIO, sancionado_at: '2026-09-01T00:00:00Z', status: 'suspendido' };
    expect((await invocar(BODY)).status).toBe(403);
    h.socio = { ...SOCIO, status: 'revocado' };
    expect((await invocar(BODY)).status).toBe(403);
    expect(h.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
  it('sin operation_id o inválido → 400; destino inválido, retirado o mismo plan → 400; paquete → sin_suscripcion', async () => {
    expect((await invocar({ tier: 'premium' })).status).toBe(400);
    expect((await invocar({ tier: 'premium', operation_id: 'nope' })).status).toBe(400);
    h.tier = null;
    expect((await invocar(BODY)).status).toBe(400);
    h.tier = { ...PREMIUM, en_venta: false };
    expect((await invocar(BODY)).status).toBe(400);
    h.tier = { ...ESENCIAL }; // mismo tier que la membresía
    expect((await invocar({ tier: 'esencial', operation_id: OP })).status).toBe(400);
    h.tier = { ...PREMIUM, tipo: 'creditos' };
    expect((await invocar(BODY)).body.reason).toBe('sin_suscripcion');
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
  it('cross-tenant: el tier se busca en el tenant del socio → 400', async () => {
    h.tier = { ...PREMIUM, tenant_id: 'otro' };
    expect((await invocar(BODY)).status).toBe(400);
  });
  it('sin membresía con suscripción → sin_suscripcion; membresía past_due → morosidad sin tocar Stripe', async () => {
    h.mem = null;
    expect((await invocar(BODY)).body.reason).toBe('sin_suscripcion');
    h.mem = { ...MEM, status: 'past_due' };
    expect((await invocar(BODY)).body).toMatchObject({ success: false, code: 'morosidad' });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('suscripción REAL (D-01F-7)', () => {
  it('customer distinto o metadata de otro usuario → sub_no_verificada', async () => {
    h.dp = { stripe_customer_id: 'cus_otro' };
    expect((await invocar(BODY)).body.code).toBe('sub_no_verificada');
    h.dp = { stripe_customer_id: 'cus_m1' };
    h.stripe.estado.subs[0].metadata.usuario_id = 'm2';
    expect((await invocar(BODY)).body.code).toBe('sub_no_verificada');
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
  it('cuenta conectada equivocada: la sub no existe allí → sub_no_verificada', async () => {
    h.mem = { ...MEM, stripe_subscription_id: 'sub_en_otra_cuenta' };
    expect((await invocar(BODY)).body.code).toBe('sub_no_verificada');
  });
  it.each([['past_due', 'morosidad'], ['unpaid', 'morosidad'], ['incomplete', 'estado_no_permitido'], ['canceled', 'estado_no_permitido'], ['trialing', 'estado_no_permitido'], ['paused', 'estado_no_permitido']])(
    'status %s en Stripe → %s, sin mutar',
    async (status, code) => {
      h.stripe.estado.subs[0].status = status;
      expect((await invocar(BODY)).body).toMatchObject({ success: false, code });
      expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    }
  );
  it('cancel_at_period_end → cancelacion_programada (no se reactiva sola)', async () => {
    h.stripe.estado.subs[0].cancel_at_period_end = true;
    expect((await invocar(BODY)).body.code).toBe('cancelacion_programada');
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(h.stripe.estado.subs[0].cancel_at_period_end).toBe(true);
  });
});

describe('guard de reservas (D-01F-4)', () => {
  it('reservas incompatibles → rechazo con la lista, ANTES de mutar Stripe; nada se cancela', async () => {
    const lista = [{ reserva_id: 'r1', folio: 'EKK-1', slot_inicio: '2026-10-05T18:00:00Z', recurso: 'Sala Pro', invitados: 0, motivo: 'estudio_no_permitido' }];
    h.rpc.mockImplementation(async (nombre: string) => (nombre === 'reservas_incompatibles_con_tier' ? { data: lista, error: null } : { data: null, error: { message: 'no debía llamarse' } }));
    const r = await invocar(BODY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: false, code: 'reservas_incompatibles', reservas: lista });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(rpcCalls('cambiar_tier_membresia')).toHaveLength(0);
    expect(rpcCalls('reservas_incompatibles_con_tier')[0][1]).toEqual({ p_usuario_id: 'm1', p_tier_id: 'tier-premium' });
  });
  it('el guard se consulta al servidor en cada intento (no se confía en el frontend)', async () => {
    await invocar(BODY);
    expect(rpcCalls('reservas_incompatibles_con_tier')).toHaveLength(1);
  });
});

describe('upgrade (D-01F-1/3): sin cobro no hay tier', () => {
  it('prorrata cobrada en el acto (always_invoice + error_if_incomplete) → transición atómica con el resumen económico', async () => {
    const r = await invocar(BODY);
    expect(r.body).toMatchObject({ success: true, tier: 'premium', tier_anterior: 'esencial', direccion: 'upgrade', idempotente: false, cobro: { amount_paid_centavos: 35000, moneda: 'mxn' } });
    const [id, params, opts] = h.stripe.subscriptions.update.mock.calls[0];
    expect(id).toBe('sub_1');
    expect(params).toMatchObject({ proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete', items: [{ id: 'si_sub_1', price: 'price_120000' }], metadata: { tier_id: 'tier-premium', swap_operation_id: OP, swap_tier_id: 'tier-premium' } });
    expect(opts).toMatchObject({ idempotencyKey: `ekko:v1:swap_mensual:acct_1:m1:${OP}`, stripeAccount: 'acct_1', maxNetworkRetries: 0 });
    const cambio = rpcCalls('cambiar_tier_membresia')[0][1] as Record<string, unknown>;
    expect(cambio).toMatchObject({ p_operation_id: OP, p_usuario_id: 'm1', p_membresia_id: 'mem1', p_tier_destino: 'tier-premium', p_stripe_subscription_id: 'sub_1', p_actor_usuario_id: 'm1' });
    expect(cambio.p_resumen).toMatchObject({ direccion: 'upgrade', precio_anterior_centavos: 85000, precio_nuevo_centavos: 120000, amount_paid_centavos: 35000, proration_behavior: 'always_invoice' });
    // La metadata de creación de 01C se conserva (no se pisa operation_id).
    expect(h.stripe.estado.subs[0].metadata.operation_id).toBe('creacion');
  });

  it('cobro fallido → Stripe no cambia nada, EKKO no cambia el tier, code cobro_fallido', async () => {
    h.stripe.fallarCobro();
    const r = await invocar(BODY);
    expect(r.body).toMatchObject({ success: false, code: 'cobro_fallido' });
    expect(h.stripe.estado.subs[0].items.data[0].price.unit_amount).toBe(85000);
    expect(rpcCalls('cambiar_tier_membresia')).toHaveLength(0);
  });

  it('si la factura devuelta no está pagada → requiere_revision y sin transición', async () => {
    h.stripe.subscriptions.update.mockImplementationOnce(async () => ({ ...h.stripe.estado.subs[0], items: { data: [{ id: 'si_sub_1', price: { id: 'price_120000', unit_amount: 120000, currency: 'mxn' } }] }, latest_invoice: { id: 'in_open', status: 'open', amount_paid: 0 } }));
    const r = await invocar(BODY);
    expect(r.body).toMatchObject({ success: false, code: 'requiere_revision' });
    expect(rpcCalls('cambiar_tier_membresia')).toHaveLength(0);
  });
});

describe('downgrade (D-01F-2)', () => {
  it('create_prorations inmediato; Stripe acepta → transición atómica, sin cobro ahora', async () => {
    h.stripe.estado.subs[0].items.data[0].price = { id: 'price_120000', unit_amount: 120000, currency: 'mxn' };
    h.mem = { ...MEM, tier_id: 'tier-premium' };
    h.tier = { ...ESENCIAL };
    const r = await invocar({ tier: 'esencial', operation_id: OP });
    expect(r.body).toMatchObject({ success: true, direccion: 'downgrade', cobro: null });
    expect(h.stripe.subscriptions.update.mock.calls[0][1]).toMatchObject({ proration_behavior: 'create_prorations' });
    expect(h.stripe.subscriptions.update.mock.calls[0][1]).not.toHaveProperty('payment_behavior');
    expect(rpcCalls('cambiar_tier_membresia')[0][1]).toMatchObject({ p_tier_destino: 'tier-esencial' });
  });
});

describe('identidad, idempotencia y recuperación', () => {
  it('doble clic / retry: misma operación → misma key → un solo update en Stripe y transición idempotente', async () => {
    await invocar(BODY);
    h.rpc.mockImplementation(async (nombre: string) =>
      nombre === 'reservas_incompatibles_con_tier' ? { data: [], error: null } : { data: { success: true, idempotente: true, membresia_id: 'mem1', tier_anterior: 'esencial', tier: 'premium' }, error: null }
    );
    const r = await invocar(BODY);
    expect(r.body).toMatchObject({ success: true, idempotente: true, recuperado: true });
    // El segundo intento vio swap_operation_id + precio destino en Stripe: no volvió a mutar.
    expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it('respuesta perdida tras el update: Stripe ya está en destino con ESTA operación → EKKO converge sin segundo update', async () => {
    // Simular: Stripe aplicó el cambio con nuestra operación pero la DB nunca se actualizó.
    h.stripe.estado.subs[0].items.data[0].price = { id: 'price_120000', unit_amount: 120000, currency: 'mxn' };
    h.stripe.estado.subs[0].metadata = { ...h.stripe.estado.subs[0].metadata, swap_operation_id: OP, swap_tier_id: 'tier-premium' };
    const r = await invocar(BODY);
    expect(r.body).toMatchObject({ success: true, recuperado: true });
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(rpcCalls('cambiar_tier_membresia')[0][1]).toMatchObject({ p_operation_id: OP });
    expect((rpcCalls('cambiar_tier_membresia')[0][1] as { p_resumen: { recuperado: boolean } }).p_resumen.recuperado).toBe(true);
  });

  it('el precio coincide pero la operación es OTRA → no se recupera por coincidencia de precio: se muta con la key propia', async () => {
    h.stripe.estado.subs[0].items.data[0].price = { id: 'price_120000', unit_amount: 120000, currency: 'mxn' };
    h.stripe.estado.subs[0].metadata = { ...h.stripe.estado.subs[0].metadata, swap_operation_id: OP2, swap_tier_id: 'tier-premium' };
    const r = await invocar(BODY);
    expect(r.body.success).toBe(true);
    expect(h.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(h.stripe.subscriptions.update.mock.calls[0][2].idempotencyKey).toBe(`ekko:v1:swap_mensual:acct_1:m1:${OP}`);
  });

  it('mismo operation_id con OTRO destino → operacion_conflicto, sin mutar', async () => {
    h.stripe.estado.subs[0].metadata = { ...h.stripe.estado.subs[0].metadata, swap_operation_id: OP, swap_tier_id: 'tier-otro' };
    expect((await invocar(BODY)).body.code).toBe('operacion_conflicto');
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('el mismo UUID de otro usuario no recupera nada: la key lleva el id del usuario', async () => {
    await invocar(BODY);
    h.socio = { ...SOCIO, id: 'm2' };
    h.mem = { ...MEM, id: 'mem2', stripe_subscription_id: 'sub_2', stripe_customer_id: 'cus_m2' };
    h.dp = { stripe_customer_id: 'cus_m2' };
    h.stripe.sembrarSuscripcion({ id: 'sub_2', customer: 'cus_m2', unit_amount: 85000, metadata: { usuario_id: 'm2', tier_id: 'tier-esencial' } });
    await invocar(BODY);
    const keys = h.stripe.subscriptions.update.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys).toEqual([`ekko:v1:swap_mensual:acct_1:m1:${OP}`, `ekko:v1:swap_mensual:acct_1:m2:${OP}`]);
  });

  it('Stripe aceptó pero la transición de EKKO falla → resultado_desconocido (el reintento converge); nunca mensaje crudo', async () => {
    h.rpc.mockImplementation(async (nombre: string) =>
      nombre === 'reservas_incompatibles_con_tier' ? { data: [], error: null } : { data: null, error: { message: 'deadlock detected at cambiar_tier_membresia' } }
    );
    const r = await invocar(BODY);
    expect(r.body).toMatchObject({ success: false, code: 'resultado_desconocido' });
    expect(JSON.stringify(r.body)).not.toMatch(/deadlock/);
    expect(h.stripe.estado.subs[0].metadata.swap_operation_id).toBe(OP); // recuperable
  });

  it('timeout de Stripe al mutar → resultado_desconocido, sin transición', async () => {
    h.stripe.subscriptions.update.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }));
    expect((await invocar(BODY)).body.code).toBe('resultado_desconocido');
    expect(rpcCalls('cambiar_tier_membresia')).toHaveLength(0);
  });
});
