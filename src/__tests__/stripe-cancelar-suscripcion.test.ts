import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06B (FR-16) · baja / reactivación al fin del periodo pedida por el miembro:
 * primero la intención durable (RPC con la sesión del miembro), luego Stripe por
 * el ejecutor común; si Stripe no confirma, se dice (`stripe_pendiente`) y la
 * operación queda para reintentarse. La función ya no llama a Stripe por su cuenta.
 */

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpcUsuario: vi.fn(),
  ejecutar: vi.fn(),
  estadoOp: 'aplicada' as string | null,
  reportar: vi.fn().mockResolvedValue(undefined),
  stripeUpdate: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn((_url: string, key: string) => ({
    auth: { getUser: h.getUser },
    rpc: (...a: unknown[]) => (key === 'anon' ? h.rpcUsuario(...a) : Promise.resolve({ data: null, error: { message: 'no' } })),
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = () => Promise.resolve({ data: h.estadoOp ? { estado: h.estadoOp } : null, error: null });
      return c;
    }
  }))
}));
vi.mock('../../netlify/functions/_lib/operacionesSuscripcion', () => ({ ejecutarOperacionesSuscripcion: (...a: unknown[]) => h.ejecutar(...a) }));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => h.reportar(...a) }));
vi.mock('../../netlify/functions/_lib/stripe', () => ({ getStripe: () => ({ subscriptions: { update: h.stripeUpdate } }) }));

import { handler } from '../../netlify/functions/stripe-cancelar-suscripcion/index';

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const invocar = async (body: Record<string, unknown>) => {
  const r = (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as never, {} as never, () => {})) as { statusCode: number; body: string };
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  h.getUser.mockResolvedValue({ data: { user: { id: 'auth-m1' } }, error: null });
  h.rpcUsuario.mockResolvedValue({ data: { success: true, operacion_id: 'op-1', usuario_id: 'u-1', cancel_at_period_end: true }, error: null });
  h.ejecutar.mockResolvedValue({ procesadas: 1, aplicadas: 1, fallidas: 0, descartadas: 0, sin_stripe: false });
  h.estadoOp = 'aplicada';
});

describe('stripe-cancelar-suscripcion (PKG-06B)', () => {
  it('12/14 · baja: intención durable con la sesión del miembro y su operation_id → ejecutor de ESE miembro → confirmada', async () => {
    const r = await invocar({ operation_id: OP });
    expect(r.status).toBe(200);
    expect(h.rpcUsuario).toHaveBeenCalledWith('miembro_programar_renovacion', { p_cancelar: true, p_operation_id: OP });
    expect(h.ejecutar).toHaveBeenCalledWith(expect.anything(), { usuarioId: 'u-1' });
    expect(h.rpcUsuario.mock.invocationCallOrder[0]).toBeLessThan(h.ejecutar.mock.invocationCallOrder[0]);
    expect(r.body).toMatchObject({ success: true, cancel_at_period_end: true, operacion_id: 'op-1', stripe_pendiente: false });
    expect(h.stripeUpdate).not.toHaveBeenCalled(); // ya no llama a Stripe por su cuenta
  });

  it('19 · reactivar viaja como p_cancelar=false', async () => {
    h.rpcUsuario.mockResolvedValue({ data: { success: true, operacion_id: 'op-2', usuario_id: 'u-1', cancel_at_period_end: false }, error: null });
    const r = await invocar({ reactivar: true, operation_id: OP });
    expect(h.rpcUsuario).toHaveBeenCalledWith('miembro_programar_renovacion', { p_cancelar: false, p_operation_id: OP });
    expect(r.body).toMatchObject({ cancel_at_period_end: false });
  });

  it('15/16/17 · Stripe falla o no responde: la intención ya quedó; 200 honesto con stripe_pendiente=true', async () => {
    h.ejecutar.mockRejectedValue(new Error('timeout'));
    h.estadoOp = 'fallida';
    const r = await invocar({ operation_id: OP });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, stripe_pendiente: true });
    expect(h.reportar).toHaveBeenCalled();
  });

  it('21/22/23 · revocación, sanción y baja del estudio: 403 con mensaje humano, sin ejecutor', async () => {
    for (const [codigo, texto] of [['CUENTA_REVOCADA', /revocado/], ['CUENTA_RESTRINGIDA', /suspendida/], ['BAJA_DEL_ESTUDIO', /programó el estudio/]] as const) {
      h.rpcUsuario.mockResolvedValueOnce({ data: null, error: { message: `EKKO_${codigo}: x` } });
      const r = await invocar({ reactivar: true, operation_id: OP });
      expect(r.status).toBe(403);
      expect(String(r.body.error)).toMatch(texto);
    }
    expect(h.ejecutar).not.toHaveBeenCalled();
  });

  it('sin suscripción / conflicto → 400; error desconocido → 500 genérico sin texto crudo', async () => {
    h.rpcUsuario.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_SIN_SUSCRIPCION: x' } });
    expect((await invocar({ operation_id: OP })).status).toBe(400);
    h.rpcUsuario.mockResolvedValueOnce({ data: null, error: { message: 'deadlock detected' } });
    const r = await invocar({ operation_id: OP });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/deadlock/);
  });

  it('una app vieja sin operation_id recibe una identidad nueva del servidor (UUID), no falla', async () => {
    await invocar({});
    const args = h.rpcUsuario.mock.calls[0][1] as { p_operation_id: string };
    expect(args.p_operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
