import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `staff-cancelar-membresia` (M14): baja desde mostrador/admin.
 *  · Con suscripción: cancel_at_period_end (reversible) → RPC; si la RPC rechaza,
 *    se revierte Stripe.
 *  · Inmediata (sin suscripción, en pausa, o pedida): RPC → subscriptions.cancel
 *    (irreversible, por eso va DESPUÉS); si Stripe falla, se reporta.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockRpc = vi.fn();
const mockSubUpdate = vi.fn();
const mockSubCancel = vi.fn();
const mockReportar = vi.fn().mockResolvedValue(undefined);
const mockOps = vi.fn((): Array<{ id: string }> => []);
/** RPC por nombre: la baja, y los dos pasos del ejecutor de operaciones de cobro. */
const PREPARADA = { ejecutar: true, tipo: 'cancelar_suscripcion', tenant_id: 't1', stripe_subscription_id: 'sub_1', idempotency_key: 'ekko:cancelar:mem-1:1' };
function rpcPorNombre(baja: { data: unknown; error: unknown } = { data: { success: true }, error: null }) {
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'operacion_suscripcion_preparar') return Promise.resolve({ data: PREPARADA, error: null });
    if (fn === 'operacion_suscripcion_resultado') return Promise.resolve({ data: { success: true }, error: null });
    return Promise.resolve(baja);
  });
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not']) chain[m] = () => chain;
      chain.maybeSingle = () => mockMaybeSingle();
      // R2-B: el ejecutor de operaciones de cobro lista las pendientes (await de la consulta).
      chain.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: mockOps(), error: null }).then(cb);
      return chain;
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { update: mockSubUpdate, cancel: mockSubCancel } })
}));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: vi.fn().mockResolvedValue({ accountId: 'acct_1', chargesEnabled: true })
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({
  reportarErrorServidor: (...a: unknown[]) => mockReportar(...a)
}));

import { handler } from '../../netlify/functions/staff-cancelar-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
async function invocar(body: unknown) {
  const e = { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
  const res = (await handler(e, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

const STAFF = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
const conSub = { id: 'mem-1', tenant_id: 't1', stripe_subscription_id: 'sub_1', status: 'activa' };
const BODY = { usuario_id: 'm1', motivo: 'Se muda de ciudad' };

beforeEach(() => {
  vi.clearAllMocks();
  mockMaybeSingle.mockReset();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockRpc.mockReset();
  mockRpc.mockResolvedValue({ data: { success: true }, error: null });
  mockOps.mockReturnValue([]);
  mockSubUpdate.mockResolvedValue({ id: 'sub_1' });
  mockSubCancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
});

describe('staff-cancelar-membresia', () => {
  it('con suscripción: no se renueva (cancel_at_period_end) y conserva el acceso; Stripe ANTES que la RPC', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: STAFF, error: null }).mockResolvedValueOnce({ data: conSub, error: null });

    const r = await invocar(BODY);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ inmediata: false });
    expect(mockSubUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true }, { stripeAccount: 'acct_1' });
    expect(mockRpc).toHaveBeenCalledWith('staff_cancelar_membresia', { p_usuario_id: 'm1', p_inmediata: false, p_motivo: 'Se muda de ciudad' });
    expect(mockSubCancel).not.toHaveBeenCalled();
    expect(mockSubUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
  });

  it('si la RPC rechaza, REVIERTE Stripe', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: STAFF, error: null }).mockResolvedValueOnce({ data: conSub, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_MOTIVO_REQUERIDO: Indica el motivo de la baja' } });

    const r = await invocar(BODY);

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Indica el motivo de la baja');
    expect(mockSubUpdate).toHaveBeenLastCalledWith('sub_1', { cancel_at_period_end: false }, { stripeAccount: 'acct_1' });
  });

  it('sin suscripción (mostrador / paquete): baja inmediata solo por la RPC', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { ...conSub, stripe_subscription_id: null }, error: null });

    const r = await invocar(BODY);

    expect(r.body).toMatchObject({ inmediata: true, stripe_cancelado: null });
    expect(mockRpc).toHaveBeenCalledWith('staff_cancelar_membresia', expect.objectContaining({ p_inmediata: true }));
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(mockSubCancel).not.toHaveBeenCalled();
  });

  it('en pausa: inmediata, y la RPC va ANTES de cancelar en Stripe (que no se puede deshacer)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { ...conSub, status: 'pausada' }, error: null });

    // R2-B (PKG-01P): la RPC dejó la operación "cancelar" (trigger); la función la ejecuta.
    mockOps.mockReturnValue([{ id: 'op-1' }]);
    rpcPorNombre();

    const r = await invocar(BODY);

    expect(r.body).toMatchObject({ inmediata: true, stripe_cancelado: true });
    expect(mockSubCancel).toHaveBeenCalledWith('sub_1', { stripeAccount: 'acct_1', idempotencyKey: 'ekko:cancelar:mem-1:1' });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockSubCancel.mock.invocationCallOrder[0]);
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual(['staff_cancelar_membresia', 'operacion_suscripcion_preparar', 'operacion_suscripcion_resultado']);
    expect(mockRpc).toHaveBeenLastCalledWith('operacion_suscripcion_resultado', { p_id: 'op-1', p_ok: true, p_error: null, p_resultado: { status: 'canceled' } });
  });

  it('inmediata y la RPC rechaza: NO se cancela nada en Stripe', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: STAFF, error: null }).mockResolvedValueOnce({ data: conSub, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_SIN_MEMBRESIA: nada que dar de baja' } });

    const r = await invocar({ ...BODY, inmediata: true });

    expect(r.status).toBe(400);
    expect(mockSubCancel).not.toHaveBeenCalled();
  });

  it('inmediata y Stripe falla al cancelar: responde OK con stripe_cancelado:false y lo REPORTA', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: STAFF, error: null }).mockResolvedValueOnce({ data: conSub, error: null });
    mockSubCancel.mockRejectedValue(new Error('stripe caído'));
    mockOps.mockReturnValue([{ id: 'op-1' }]);
    rpcPorNombre();

    const r = await invocar({ ...BODY, inmediata: true });

    // La baja en EKKO no se deshace; la operación queda FALLIDA en la base
    // (evidencia durable + reintento), no solo en Sentry.
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stripe_cancelado: false });
    expect(mockRpc).toHaveBeenLastCalledWith('operacion_suscripcion_resultado',
      expect.objectContaining({ p_id: 'op-1', p_ok: false, p_error: expect.stringContaining('stripe caído') }));
    expect(mockReportar).toHaveBeenCalledTimes(1);
  });

  it('membresía de OTRO estudio → 403, sin tocar Stripe ni la RPC', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { ...conSub, tenant_id: 'otro' }, error: null });
    const r = await invocar(BODY);
    expect(r.status).toBe(403);
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sin motivo → 400; un miembro o un staff revocado → 403', async () => {
    expect((await invocar({ usuario_id: 'm1', motivo: 'no' })).status).toBe(400);

    mockMaybeSingle.mockResolvedValueOnce({ data: { ...STAFF, rol: 'miembro' }, error: null });
    expect((await invocar(BODY)).status).toBe(403);

    mockMaybeSingle.mockResolvedValueOnce({ data: { ...STAFF, status: 'revocado' }, error: null });
    expect((await invocar(BODY)).status).toBe(403);
  });
});
