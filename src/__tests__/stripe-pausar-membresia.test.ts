import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `stripe-pausar-membresia` · PKG-02H: RPC primero (intención EKKO-138 + operación
 * durable en `stripe_operaciones_suscripcion`), ejecutor después. Stripe nunca se
 * toca antes de que EKKO tenga escrita la intención; un fallo de Stripe deja la
 * operación fallida (visible, reintentable) y la respuesta lo dice. Stripe simulado.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockRpc = vi.fn();
const mockSubUpdate = vi.fn();
const mockReportar = vi.fn().mockResolvedValue(undefined);
const mockOps = vi.fn((): Array<{ id: string }> => []);

const PREP_PAUSA = { ejecutar: true, tipo: 'suspender_cobro', tenant_id: 't1', stripe_subscription_id: 'sub_1', idempotency_key: 'ekko:pausar_staff:mem-1:1700000000000:1' };
const PREP_REANUDA = { ...PREP_PAUSA, tipo: 'reanudar_cobro', idempotency_key: 'ekko:reactivar_staff:mem-1:1700000000000:1' };
function rpcPorNombre(rpc: { data: unknown; error: unknown }, preparada: typeof PREP_PAUSA | { ejecutar: false; estado: string; motivo: string } = PREP_PAUSA) {
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'operacion_suscripcion_preparar') return Promise.resolve({ data: preparada, error: null });
    if (fn === 'operacion_suscripcion_resultado') return Promise.resolve({ data: { success: true }, error: null });
    return Promise.resolve(rpc);
  });
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'is']) chain[m] = () => chain;
      chain.maybeSingle = () => mockMaybeSingle();
      chain.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: mockOps(), error: null }).then(cb);
      return chain;
    })
  }))
}));
vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { update: mockSubUpdate } })
}));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: vi.fn().mockResolvedValue({ accountId: 'acct_1', chargesEnabled: true })
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => mockReportar(...a) }));

import { handler } from '../../netlify/functions/stripe-pausar-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
async function invocar(body: unknown) {
  const e = { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
  const res = (await handler(e, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

const STAFF = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
const nombres = () => mockRpc.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mockMaybeSingle.mockReset();
  mockRpc.mockReset();
  mockOps.mockReturnValue([]);
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockMaybeSingle.mockResolvedValue({ data: STAFF, error: null });
  mockSubUpdate.mockResolvedValue({ id: 'sub_1', status: 'active', pause_collection: { behavior: 'void' } });
});

describe('stripe-pausar-membresia (PKG-02H)', () => {
  it('pausar: la RPC va PRIMERO y deja la operación; el ejecutor aplica pause_collection void con la llave de la operación', async () => {
    mockOps.mockReturnValue([{ id: 'op-p' }]);
    rpcPorNombre({ data: { success: true, operacion_cobro: true, stripe_subscription_id: 'sub_1' }, error: null });
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(r.status).toBe(200);
    expect(nombres()).toEqual(['staff_pausar_membresia', 'operacion_suscripcion_preparar', 'operacion_suscripcion_resultado']);
    expect(mockRpc).toHaveBeenCalledWith('staff_pausar_membresia', { p_usuario_id: 'u1', p_pausar: true, p_motivo: 'Viaje' });
    expect(mockSubUpdate).toHaveBeenCalledWith('sub_1', { pause_collection: { behavior: 'void' } }, { stripeAccount: 'acct_1', idempotencyKey: PREP_PAUSA.idempotency_key });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockSubUpdate.mock.invocationCallOrder[0]);
    expect(r.body).toMatchObject({ stripe_pausado: true, cobro_pendiente: false });
  });

  it('reanudar: misma secuencia con pause_collection null', async () => {
    mockOps.mockReturnValue([{ id: 'op-r' }]);
    rpcPorNombre({ data: { success: true, operacion_cobro: true }, error: null }, PREP_REANUDA);
    mockSubUpdate.mockResolvedValue({ id: 'sub_1', status: 'active', pause_collection: null });
    const r = await invocar({ usuario_id: 'u1', pausar: false, motivo: 'Regresó' });
    expect(r.status).toBe(200);
    expect(mockSubUpdate).toHaveBeenCalledWith('sub_1', { pause_collection: null }, { stripeAccount: 'acct_1', idempotencyKey: PREP_REANUDA.idempotency_key });
    expect(r.body).toMatchObject({ stripe_pausado: true, cobro_pendiente: false });
  });

  it('si la RPC rechaza, Stripe NO se toca (no hay nada que revertir) y se devuelve el mensaje humano', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que pausar' } });
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El miembro no tiene una membresía vigente que pausar');
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });

  it('Stripe falla (o timeout ambiguo): EKKO ya quedó pausada; la operación queda FALLIDA con el error y la respuesta dice cobro_pendiente', async () => {
    mockOps.mockReturnValue([{ id: 'op-p' }]);
    rpcPorNombre({ data: { success: true, operacion_cobro: true }, error: null });
    mockSubUpdate.mockRejectedValue(Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }));
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stripe_pausado: false, cobro_pendiente: true });
    expect(mockRpc).toHaveBeenLastCalledWith('operacion_suscripcion_resultado',
      expect.objectContaining({ p_id: 'op-p', p_ok: false, p_error: expect.stringContaining('StripeConnectionError') }));
  });

  it('petición duplicada / reintento: la RPC es idempotente y, sin operación nueva, no se llama a Stripe otra vez', async () => {
    rpcPorNombre({ data: { success: true, idempotente: true, operacion_cobro: false }, error: null });
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(r.status).toBe(200);
    expect(nombres()).toEqual(['staff_pausar_membresia']);
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ stripe_pausado: false, cobro_pendiente: false });
  });

  it('la operación que el ejecutor encuentra ya no procede (p. ej. reactivada antes de aplicarse): se descarta, Stripe no se toca', async () => {
    mockOps.mockReturnValue([{ id: 'op-p' }]);
    rpcPorNombre({ data: { success: true, operacion_cobro: true }, error: null }, { ejecutar: false, estado: 'descartada', motivo: 'reactivada' });
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ stripe_pausado: false, cobro_pendiente: false });
  });

  it('EKKO-139 · reactivar a un miembro SANCIONADO: la RPC no crea reanudación; nada reanuda el cobro en Stripe', async () => {
    rpcPorNombre({ data: { success: true, operacion_cobro: false, cobro_suspendido_por_sancion: true }, error: null });
    const r = await invocar({ usuario_id: 'u1', pausar: false, motivo: 'Regresó del viaje' });
    expect(r.status).toBe(200);
    expect(mockSubUpdate).not.toHaveBeenCalledWith('sub_1', { pause_collection: null }, expect.anything());
    expect(r.body).toMatchObject({ stripe_pausado: false, cobro_suspendido_por_sancion: true });
  });

  it('paquete / mostrador (sin suscripción): solo la RPC; nada en Stripe', async () => {
    rpcPorNombre({ data: { success: true, operacion_cobro: false, stripe_subscription_id: null }, error: null });
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Lesión' });
    expect(r.status).toBe(200);
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ stripe_pausado: false, cobro_pendiente: false });
  });

  it('sin Stripe configurado: la operación queda pendiente para el ejecutor (cobro_pendiente) y nada se afirma', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    rpcPorNombre({ data: { success: true, operacion_cobro: true }, error: null });
    const r = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(r.body).toMatchObject({ stripe_pausado: false, cobro_pendiente: true });
    expect(nombres()).toEqual(['staff_pausar_membresia']);
  });

  it('sin motivo → 400; miembro → 403; staff inactivo → 403; sin tocar la RPC ni Stripe', async () => {
    expect((await invocar({ usuario_id: 'u1', pausar: true })).status).toBe(400);
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...STAFF, rol: 'miembro' }, error: null });
    expect((await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' })).status).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...STAFF, status: 'revocado' }, error: null });
    expect((await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' })).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSubUpdate).not.toHaveBeenCalled();
  });
});
