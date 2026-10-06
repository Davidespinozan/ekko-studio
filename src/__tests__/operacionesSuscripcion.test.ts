import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * R2-B (PKG-01P) · Ejecutor de operaciones de cobro, con Stripe SIMULADO.
 * La base decide qué operación toca (stripe_operaciones_suscripcion + preparar);
 * aquí se prueba que se llama a Stripe con la llamada correcta y la llave de
 * idempotencia de la operación, y que el resultado SIEMPRE se asienta en la
 * base: aplicada o fallida. Ninguna llamada real a Stripe.
 */

const h = vi.hoisted(() => ({
  ops: [] as Array<{ id: string }>,
  preparadas: {} as Record<string, Record<string, unknown>>,
  rpc: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  reportar: vi.fn().mockResolvedValue(undefined),
  cuenta: vi.fn(),
  filtros: [] as Array<[string, unknown]>
}));

vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { update: h.update, cancel: h.cancel } })
}));
vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: (...a: unknown[]) => h.cuenta(...a)
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({
  reportarErrorServidor: (...a: unknown[]) => h.reportar(...a)
}));

import { ejecutarOperacionesSuscripcion, describirErrorProveedor } from '../../netlify/functions/_lib/operacionesSuscripcion';

function admin() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit']) chain[m] = () => chain;
  chain.in = (col: string, val: unknown) => { h.filtros.push([`in:${col}`, val]); return chain; };
  chain.eq = (col: string, val: unknown) => { h.filtros.push([col, val]); return chain; };
  chain.is = (col: string, val: unknown) => { h.filtros.push([`is:${col}`, val]); return chain; };
  chain.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: h.ops, error: null }).then(cb);
  return { from: () => chain, rpc: (...a: unknown[]) => h.rpc(...a) } as never;
}
const prep = (tipo: string, extra: Record<string, unknown> = {}) => ({
  ejecutar: true, tipo, tenant_id: 't1', stripe_subscription_id: 'sub_1', idempotency_key: `ekko:${tipo}:1`, ...extra
});
const resultados = () => h.rpc.mock.calls.filter((c) => c[0] === 'operacion_suscripcion_resultado').map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  h.ops = [];
  h.preparadas = {};
  h.filtros = [];
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  h.cuenta.mockResolvedValue({ accountId: 'acct_1', chargesEnabled: true });
  h.update.mockResolvedValue({ id: 'sub_1', status: 'active', pause_collection: { behavior: 'void' } });
  h.cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
  h.rpc.mockImplementation((fn: string, args: { p_id: string }) =>
    Promise.resolve(fn === 'operacion_suscripcion_preparar'
      ? { data: h.preparadas[args.p_id], error: null }
      : { data: { success: true }, error: null }));
});

describe('ejecutarOperacionesSuscripcion', () => {
  it('sanción → pause_collection void con la llave de idempotencia de la operación; resultado aplicada', async () => {
    h.ops = [{ id: 'op-s' }];
    h.preparadas['op-s'] = prep('suspender_cobro');
    const r = await ejecutarOperacionesSuscripcion(admin(), { usuarioId: 'm1' });
    expect(h.filtros).toContainEqual(['usuario_id', 'm1']);
    // PKG-03A: una operación con los reintentos agotados ya no la toma el ejecutor.
    expect(h.filtros).toContainEqual(['is:reintentos_agotados_at', null]);
    expect(h.update).toHaveBeenCalledWith('sub_1', { pause_collection: { behavior: 'void' } }, { stripeAccount: 'acct_1', idempotencyKey: 'ekko:suspender_cobro:1' });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(resultados()).toEqual([{ p_id: 'op-s', p_ok: true, p_error: null, p_resultado: { status: 'active', pause_collection: 'void' } }]);
    expect(r).toEqual({ procesadas: 1, aplicadas: 1, fallidas: 0, descartadas: 0, sin_stripe: false });
  });

  it('levantar sanción → pause_collection null (reanuda); nunca cancela', async () => {
    h.ops = [{ id: 'op-r' }];
    h.preparadas['op-r'] = prep('reanudar_cobro');
    h.update.mockResolvedValue({ id: 'sub_1', status: 'active', pause_collection: null });
    await ejecutarOperacionesSuscripcion(admin());
    expect(h.update).toHaveBeenCalledWith('sub_1', { pause_collection: null }, expect.objectContaining({ idempotencyKey: 'ekko:reanudar_cobro:1' }));
    expect(h.cancel).not.toHaveBeenCalled();
    expect(resultados()[0]).toMatchObject({ p_ok: true, p_resultado: { status: 'active', pause_collection: null } });
  });

  it('revocación / baja → subscriptions.cancel INMEDIATO (no cancel_at_period_end) y sin reembolso', async () => {
    h.ops = [{ id: 'op-c' }];
    h.preparadas['op-c'] = prep('cancelar_suscripcion');
    await ejecutarOperacionesSuscripcion(admin());
    expect(h.cancel).toHaveBeenCalledWith('sub_1', { stripeAccount: 'acct_1', idempotencyKey: 'ekko:cancelar_suscripcion:1' });
    expect(h.update).not.toHaveBeenCalled();
    expect(resultados()[0]).toMatchObject({ p_ok: true, p_resultado: { status: 'canceled' } });
  });

  it('Stripe falla (timeout): la operación queda FALLIDA en la base con el error, se reporta, y no se lanza', async () => {
    h.ops = [{ id: 'op-s' }];
    h.preparadas['op-s'] = prep('suspender_cobro');
    h.update.mockRejectedValue(Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' }));
    const r = await ejecutarOperacionesSuscripcion(admin());
    expect(resultados()).toEqual([{ p_id: 'op-s', p_ok: false, p_error: 'StripeConnectionError:Request timed out', p_resultado: {} }]);
    expect(r).toMatchObject({ aplicadas: 0, fallidas: 1 });
    expect(h.reportar).toHaveBeenCalledTimes(1);
  });

  it('reintento: la base entrega OTRA llave (otro intento) para la MISMA operación', async () => {
    h.ops = [{ id: 'op-s' }];
    h.preparadas['op-s'] = prep('suspender_cobro', { idempotency_key: 'ekko:suspender:mem-1:99:2' });
    await ejecutarOperacionesSuscripcion(admin());
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][2]).toMatchObject({ idempotencyKey: 'ekko:suspender:mem-1:99:2' });
  });

  it('cancelar una suscripción que ya no existe o ya estaba cancelada = aplicada (idempotente)', async () => {
    h.ops = [{ id: 'op-c' }];
    h.preparadas['op-c'] = prep('cancelar_suscripcion');
    h.cancel.mockRejectedValue(Object.assign(new Error('No such subscription: sub_1'), { code: 'resource_missing' }));
    const r = await ejecutarOperacionesSuscripcion(admin());
    expect(resultados()[0]).toMatchObject({ p_ok: true, p_resultado: { status: 'canceled', nota: 'ya_estaba_cancelada' } });
    expect(r.aplicadas).toBe(1);
    expect(h.reportar).not.toHaveBeenCalled();
  });

  it('la base descarta la operación (cuenta revocada, membresía cancelada…): NO se llama a Stripe', async () => {
    h.ops = [{ id: 'op-r' }, { id: 'op-x' }];
    h.preparadas['op-r'] = { ejecutar: false, estado: 'descartada', motivo: 'cuenta_revocada' };
    h.preparadas['op-x'] = { ejecutar: false, estado: 'aplicada', motivo: 'ya_aplicada' };
    const r = await ejecutarOperacionesSuscripcion(admin());
    expect(h.update).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(resultados()).toEqual([]);
    expect(r).toMatchObject({ procesadas: 2, descartadas: 1, aplicadas: 0, fallidas: 0 });
  });

  it('estudio sin cuenta conectada: fallida con motivo claro, sin llamar a Stripe', async () => {
    h.ops = [{ id: 'op-c' }];
    h.preparadas['op-c'] = prep('cancelar_suscripcion');
    h.cuenta.mockResolvedValue({ accountId: null, chargesEnabled: false });
    await ejecutarOperacionesSuscripcion(admin());
    expect(h.cancel).not.toHaveBeenCalled();
    expect(resultados()[0]).toMatchObject({ p_ok: false, p_error: expect.stringContaining('cuenta_conectada_no_resuelta') });
  });

  it('sin Stripe configurado: no consulta ni llama a nada; las operaciones siguen pendientes', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    h.ops = [{ id: 'op-s' }];
    const r = await ejecutarOperacionesSuscripcion(admin());
    expect(r).toEqual({ procesadas: 0, aplicadas: 0, fallidas: 0, descartadas: 0, sin_stripe: true });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('varias operaciones: una falla y la otra se aplica (una no bloquea a la otra)', async () => {
    h.ops = [{ id: 'a' }, { id: 'b' }];
    h.preparadas.a = prep('suspender_cobro');
    h.preparadas.b = prep('cancelar_suscripcion', { stripe_subscription_id: 'sub_2' });
    h.update.mockRejectedValue(new Error('boom'));
    const r = await ejecutarOperacionesSuscripcion(admin());
    expect(r).toMatchObject({ procesadas: 2, aplicadas: 1, fallidas: 1 });
    expect(h.cancel).toHaveBeenCalledWith('sub_2', expect.anything());
  });

  it('el error asentado lleva tipo y código, recortado', () => {
    expect(describirErrorProveedor(Object.assign(new Error('x'.repeat(500)), { type: 'api_error', code: 'rate_limit' })).length).toBeLessThanOrEqual(190);
    expect(describirErrorProveedor(Object.assign(new Error('caída'), { type: 'api_error', code: 'rate_limit' }))).toBe('api_error:rate_limit:caída');
  });
});

describe('PKG-06B · tipos del miembro y del webhook', () => {
  it('solo pide a la base los tipos que sabe ejecutar: `cambiar_plan` nunca entra al ejecutor', async () => {
    await ejecutarOperacionesSuscripcion(admin());
    const tipos = h.filtros.find(([c]) => c === 'in:tipo')?.[1] as string[];
    expect(tipos).toEqual(['suspender_cobro', 'reanudar_cobro', 'cancelar_suscripcion', 'cancelar_fin_periodo', 'reanudar_renovacion']);
    expect(tipos).not.toContain('cambiar_plan');
  });

  it('reanudar_renovacion (el miembro revierte su baja) → cancel_at_period_end:false con la llave de la operación', async () => {
    h.ops = [{ id: 'op-r' }];
    h.preparadas['op-r'] = prep('reanudar_renovacion', { idempotency_key: 'ekko:renovacion_miembro:abc:1' });
    h.update.mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: false });
    await ejecutarOperacionesSuscripcion(admin());
    expect(h.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false }, { stripeAccount: 'acct_1', idempotencyKey: 'ekko:renovacion_miembro:abc:1' });
    expect(resultados()[0]).toMatchObject({ p_id: 'op-r', p_ok: true, p_resultado: { cancel_at_period_end: false } });
  });

  it('un tipo desconocido que llegara a preparar NO se traduce en ninguna llamada a Stripe: queda fallida', async () => {
    h.ops = [{ id: 'op-x' }];
    h.preparadas['op-x'] = prep('cambiar_plan');
    await ejecutarOperacionesSuscripcion(admin());
    expect(h.update).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(resultados()[0]).toMatchObject({ p_id: 'op-x', p_ok: false });
    expect(String((resultados()[0] as { p_error: string }).p_error)).toMatch(/tipo_no_ejecutable/);
  });
});
