import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `stripe-pausar-membresia`: Stripe primero (pause_collection), luego la RPC
 * staff_pausar_membresia con el token del staff; si la RPC rechaza, revierte
 * Stripe. Sin suscripción (paquete/mostrador) solo pasa por la RPC.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockRpc = vi.fn();
const mockSubUpdate = vi.fn();
const mockPush = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not']) chain[m] = () => chain;
      chain.maybeSingle = () => mockMaybeSingle();
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
vi.mock('../../netlify/functions/_lib/push', () => ({
  enviarPushAUsuario: (...a: unknown[]) => mockPush(...a)
}));

import { handler } from '../../netlify/functions/stripe-pausar-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(body: unknown): AnyEvent {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
}
async function invocar(body: unknown) {
  const res = await handler(evento(body), {} as never, () => {});
  return res as { statusCode: number; body: string };
}

const STAFF = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };

describe('stripe-pausar-membresia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    mockRpc.mockResolvedValue({ data: { success: true }, error: null });
    mockSubUpdate.mockResolvedValue({ id: 'sub_1' });
    mockPush.mockResolvedValue({ enviados: 1 });
  });

  it('pausar con suscripción: Stripe pause_collection void → RPC; el push lo reparte cron-push (no dos veces)', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 't1', stripe_subscription_id: 'sub_1', status: 'activa' }, error: null });
    const res = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(res.statusCode).toBe(200);
    expect(mockSubUpdate).toHaveBeenCalledWith('sub_1', { pause_collection: { behavior: 'void' } }, { stripeAccount: 'acct_1' });
    expect(mockRpc).toHaveBeenCalledWith('staff_pausar_membresia', { p_usuario_id: 'u1', p_pausar: true, p_motivo: 'Viaje' });
    expect(JSON.parse(res.body).stripe_pausado).toBe(true);
    // La RPC deja el aviso en `notificaciones`; empujarlo también aquí lo duplicaba.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('reanudar: pause_collection null', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 't1', stripe_subscription_id: 'sub_1', status: 'pausada' }, error: null });
    const res = await invocar({ usuario_id: 'u1', pausar: false, motivo: 'Regresó' });
    expect(res.statusCode).toBe(200);
    expect(mockSubUpdate).toHaveBeenCalledWith('sub_1', { pause_collection: null }, { stripeAccount: 'acct_1' });
  });

  it('si la RPC rechaza, revierte Stripe y devuelve el mensaje humano', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 't1', stripe_subscription_id: 'sub_1', status: 'activa' }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que pausar' } });
    const res = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('El miembro no tiene una membresía vigente que pausar');
    expect(mockSubUpdate).toHaveBeenCalledTimes(2);
    expect(mockSubUpdate).toHaveBeenLastCalledWith('sub_1', { pause_collection: null }, { stripeAccount: 'acct_1' });
  });

  it('paquete / mostrador (sin sub): no toca Stripe, solo RPC', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 't1', stripe_subscription_id: null, status: 'activa' }, error: null });
    const res = await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Lesión' });
    expect(res.statusCode).toBe(200);
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).stripe_pausado).toBe(false);
  });

  it('membresía de otro tenant → 403 antes de tocar Stripe; sin motivo → 400; miembro → 403', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: STAFF, error: null })
      .mockResolvedValueOnce({ data: { id: 'm1', tenant_id: 'otro', stripe_subscription_id: 'sub_1', status: 'activa' }, error: null });
    expect((await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' })).statusCode).toBe(403);
    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect((await invocar({ usuario_id: 'u1', pausar: true })).statusCode).toBe(400);
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...STAFF, rol: 'miembro' }, error: null });
    expect((await invocar({ usuario_id: 'u1', pausar: true, motivo: 'Viaje' })).statusCode).toBe(403);
  });
});
