import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pagos — `reception-activar-membresia`: venta de MOSTRADOR. PKG-01D: pasa por
 * la primitiva transaccional `registrar_venta_mostrador` (evidencia durable +
 * activación por R1 en una transacción, idempotente por operation_id) y audita.
 * Exige operation_id (UUID) y metodo; rechaza body inválido, tier inactivo y
 * cross-tenant; mapea los errores estructurados del RPC a 400/403/409.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn(); // usuarios (caller, target)
const mockTierMaybe = vi.fn();   // tiers
const mockRpc = vi.fn();
const mockAuditInsert = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      if (table === 'tiers') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTierMaybe })) })) }))
          }))
        };
      }
      // usuarios
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) };
    })
  }))
}));

import { handler } from '../../netlify/functions/reception-activar-membresia/index';

type AnyEvent = Parameters<typeof handler>[0];
function evento(body: unknown): AnyEvent {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent;
}
async function invocar(event: AnyEvent) {
  return (await handler(event, {} as never, () => {})) as { statusCode: number; body: string };
}

const OP = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const VENTA = { usuario_id: 'm1', tier: 'pro', operation_id: OP, metodo: 'efectivo' };
const RPC_OK = { success: true, idempotente: false, venta_id: 'v1', membresia_id: 'mem1', tier: 'pro', metodo: 'efectivo', precio_lista_centavos: 120000, monto_cobrado_centavos: 120000, moneda: 'MXN', activacion: { success: true } };
const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
const TARGET = { id: 'm1', tenant_id: 't1', rol: 'miembro', status: 'pendiente_pago', membresia_tier: 'pro' };
const TIER = { id: 'tier1', slug: 'pro' };

describe('reception-activar-membresia (Pagos)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    mockTierMaybe.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockRpc.mockResolvedValue({ data: RPC_OK, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('activa: llama al RPC keystone y audita', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });

    const res = await invocar(evento({ ...VENTA, nota: 'pagó en caja', referencia: 'folio 1' }));
    expect(res.statusCode).toBe(200);
    // Sin `confirmar_perdida: true` explícito, el servidor NO autoriza perder créditos.
    // El actor sale del JWT; el cliente no manda importes.
    expect(mockRpc).toHaveBeenCalledWith('registrar_venta_mostrador', {
      p_operation_id: OP,
      p_actor_id: 'u-recep',
      p_usuario_id: 'm1',
      p_tier_id: 'tier1',
      p_metodo: 'efectivo',
      p_referencia: 'folio 1',
      p_nota: 'pagó en caja',
      p_confirmar_perdida: false
    });
    expect(JSON.parse(res.body)).toMatchObject({ success: true, idempotente: false, venta: { id: 'v1', membresia_id: 'mem1', metodo: 'efectivo', monto_cobrado_centavos: 120000, precio_lista_centavos: 120000 } });
    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.accion).toBe('membership_activated');
    expect(audit.target_id).toBe('m1');
    expect(audit.metadata).toMatchObject({ via: 'mostrador', venta_id: 'v1', operation_id: OP, metodo: 'efectivo', monto_cobrado_centavos: 120000 });
  });

  it('el RPC rechaza por pérdida de créditos → 409 con el saldo en juego, sin auditar nada', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'EKKO_PERDERIA_CREDITOS: El miembro perdería 8 crédito(s) al cambiar a este plan' }
    });

    const res = await invocar(evento(VENTA));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'perderia_creditos', creditos: 8 });
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('con confirmar_perdida:true el servidor autoriza y lo deja en la bitácora', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });

    const res = await invocar(evento({ ...VENTA, confirmar_perdida: true, motivo: 'Pidió pasar a mensual' }));

    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('registrar_venta_mostrador', expect.objectContaining({ p_confirmar_perdida: true, p_nota: 'Pidió pasar a mensual' }));
    const audit = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.motivo).toBe('Pidió pasar a mensual');
    expect(audit.metadata).toMatchObject({ perdida_de_creditos_confirmada: true });
  });

  it('sin tier → 400', async () => {
    const res = await invocar(evento({ usuario_id: 'm1' }));
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('tier inactivo / no encontrado → 400', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: null, error: null });
    const res = await invocar(evento({ ...VENTA, tier: 'fantasma' }));
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('cross-tenant → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: { ...TARGET, tenant_id: 'otro' }, error: null });
    const res = await invocar(evento(VENTA));
    expect(res.statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('un miembro no puede → 403', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(evento(VENTA));
    expect(res.statusCode).toBe(403);
  });

  it('F2 · R1: el audit registra el estado REAL tras la activación (sanción → suspendido), no "activo"', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null })
      .mockResolvedValueOnce({ data: { status: 'suspendido', membresia_tier: 'pro' }, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });

    const res = await invocar(evento(VENTA));

    expect(res.statusCode).toBe(200);
    const fila = mockAuditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(fila.accion).toBe('membership_activated');
    expect(fila.despues).toEqual({ status: 'suspendido', membresia_tier: 'pro' });
  });
});

// ── PKG-01D ──────────────────────────────────────────────────────────────────
describe('reception-activar-membresia · venta de mostrador (PKG-01D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockReset();
    mockTierMaybe.mockReset();
    mockRpc.mockReset();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockRpc.mockResolvedValue({ data: RPC_OK, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    mockTierMaybe.mockResolvedValue({ data: TIER, error: null });
  });

  it('D-01D-5 · sin operation_id → 400 claro; sin tocar el RPC. No hay camino legacy', async () => {
    const res = await invocar(evento({ usuario_id: 'm1', tier: 'pro', metodo: 'efectivo' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/operation_id/);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('operation_id que no es UUID → 400', async () => {
    const res = await invocar(evento({ ...VENTA, operation_id: 'venta-1' }));
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('sin metodo o fuera del enum → 400', async () => {
    expect((await invocar(evento({ usuario_id: 'm1', tier: 'pro', operation_id: OP }))).statusCode).toBe(400);
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    expect((await invocar(evento({ ...VENTA, metodo: 'bitcoin' }))).statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('cualquier importe que mande el cliente se IGNORA: el RPC no recibe montos', async () => {
    const res = await invocar(evento({ ...VENTA, monto_cobrado_centavos: 1, precio_lista_centavos: 1, moneda: 'USD' }));
    expect(res.statusCode).toBe(200);
    const args = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(['p_actor_id', 'p_confirmar_perdida', 'p_metodo', 'p_nota', 'p_operation_id', 'p_referencia', 'p_tier_id', 'p_usuario_id']);
  });

  it('cortesía se manda como método; el importe lo decide el servidor', async () => {
    mockRpc.mockResolvedValueOnce({ data: { ...RPC_OK, metodo: 'cortesia', monto_cobrado_centavos: 0 }, error: null });
    const res = await invocar(evento({ ...VENTA, metodo: 'cortesia' }));
    expect(JSON.parse(res.body).venta).toMatchObject({ metodo: 'cortesia', monto_cobrado_centavos: 0, precio_lista_centavos: 120000 });
  });

  it('replay (idempotente:true) → 200 con la MISMA venta y sin volver a auditar', async () => {
    mockRpc.mockResolvedValueOnce({ data: { ...RPC_OK, idempotente: true }, error: null });
    const res = await invocar(evento(VENTA));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ idempotente: true, venta: { id: 'v1', membresia_id: 'mem1' } });
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('D-01D-3 · suscripción de Stripe viva → 409 suscripcion_stripe, sin auditar', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_TIENE_SUSCRIPCION_STRIPE: El miembro tiene una suscripción de Stripe vigente; cancélala primero' } });
    const res = await invocar(evento(VENTA));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'suscripcion_stripe' });
    expect(JSON.parse(res.body).error).toMatch(/suscripción de Stripe/);
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('operation_id ligado a otra venta → 409 operacion_conflicto', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_OPERACION_MOSTRADOR_CONFLICTO: El operation_id ya corresponde a otra venta' } });
    const res = await invocar(evento(VENTA));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'operacion_conflicto' });
  });

  it('actor/tenant rechazados por el RPC → 403; error inesperado → 500 sin mensaje crudo', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_ACTOR_NO_AUTORIZADO: Solo recepción o admin' } });
    expect((await invocar(evento(VENTA))).statusCode).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: CALLER, error: null }).mockResolvedValueOnce({ data: TARGET, error: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'deadlock detected at pg_advisory_xact_lock' } });
    const res = await invocar(evento(VENTA));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).not.toMatch(/deadlock|advisory/);
    expect(JSON.parse(res.body).error).toMatch(/misma operación/);
  });
});
