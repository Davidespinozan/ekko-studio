import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06A · `reception-update-member`: la parte local (nombre/teléfono/status/
 * sanción/desbloqueo/foto + restauración de revocado + auditoría con actor) es la
 * RPC `staff_actualizar_cuenta` en UNA transacción; el correo va primero a Auth y
 * después a la RPC. Aquí se prueba el orden, los 400/403 tempranos, el contrato
 * parcial honesto y que las operaciones de cobro (R2-B) se ejecutan DESPUÉS.
 * Las reglas de dominio de la RPC se prueban en db/06a-cuentas-compuestas.
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdateUserById = vi.fn();
const mockRpc = vi.fn();
const mockUpload = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (...a: unknown[]) => mockRpc(...a),
    auth: {
      getUser: mockGetUser,
      admin: { updateUserById: mockUpdateUserById }
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) }))
    })),
    storage: {
      from: vi.fn(() => ({
        upload: (...a: unknown[]) => mockUpload(...a),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://cdn.test/a.jpg' } }))
      }))
    }
  }))
}));

// R2-B (PKG-01P): el ejecutor de operaciones de cobro (Stripe) se simula; su
// comportamiento real se prueba en operacionesSuscripcion.test.ts.
const mockEjecutar = vi.fn();
vi.mock('../../netlify/functions/_lib/operacionesSuscripcion', () => ({
  ejecutarOperacionesSuscripcion: (...a: unknown[]) => mockEjecutar(...a)
}));
const mockReportarError = vi.fn().mockResolvedValue(undefined);
vi.mock('../../netlify/functions/_lib/sentry', () => ({
  reportarErrorServidor: (...a: unknown[]) => mockReportarError(...a)
}));

import { handler } from '../../netlify/functions/reception-update-member/index';

type AnyEvent = Parameters<typeof handler>[0];

function evento(body: unknown): AnyEvent {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: JSON.stringify(body)
  } as unknown as AnyEvent;
}

async function invocar(event: AnyEvent) {
  const res = await handler(event, {} as never, () => {});
  return res as { statusCode: number; body: string };
}

const CALLER = { id: 'u-recep', tenant_id: 't1', rol: 'recepcionista', status: 'activo', nombre: 'Recep' };
const TARGET = { id: 'm-1', auth_id: 'auth-m1', tenant_id: 't1', rol: 'miembro', email: 'ana@cravia.mx', status: 'activo' };

function setCallerTarget(target: Record<string, unknown> = TARGET, caller: Record<string, unknown> = CALLER) {
  mockMaybeSingle
    .mockResolvedValueOnce({ data: caller, error: null })
    .mockResolvedValueOnce({ data: target, error: null });
}
const rpcOk = (cambios: string[], status = 'activo') => ({ data: { success: true, sin_cambios: false, cambios, status, avatar_url: null }, error: null });
const llamadasRpc = () => mockRpc.mock.calls.map((c) => c[1] as Record<string, unknown>);

describe('reception-update-member (PKG-06A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockUpdateUserById.mockResolvedValue({ error: null });
    mockUpload.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue(rpcOk(['status→suspendido'], 'suspendido'));
    mockEjecutar.mockResolvedValue({ procesadas: 0, aplicadas: 0, fallidas: 0, descartadas: 0, sin_stripe: false });
  });

  it('R2-B: cambiar el status va a la RPC (actor, cambios, motivo) y DESPUÉS se ejecutan las operaciones de cobro de ESE miembro', async () => {
    setCallerTarget();
    mockEjecutar.mockResolvedValue({ procesadas: 1, aplicadas: 1, fallidas: 0, descartadas: 0, sin_stripe: false });
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'suspendido', motivo: 'Daños al equipo' }));
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('staff_actualizar_cuenta', {
      p_actor_id: 'u-recep', p_usuario_id: 'm-1', p_cambios: { status: 'suspendido' }, p_motivo: 'Daños al equipo'
    });
    expect(mockEjecutar.mock.calls[0][1]).toEqual({ usuarioId: 'm-1' });
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockEjecutar.mock.invocationCallOrder[0]);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, status: 'suspendido', cambios: ['status→suspendido'], cobro_stripe: { aplicadas: 1 } });
  });

  it('R2-B: si Stripe falla o el ejecutor revienta, la sanción NO se deshace: 200, cambio hecho, error reportado', async () => {
    setCallerTarget();
    mockEjecutar.mockRejectedValue(new Error('stripe caído'));
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'suspendido', motivo: 'Daños al equipo' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cobro_stripe).toBeNull();
    expect(mockReportarError).toHaveBeenCalledTimes(1);
  });

  it('un cambio de contacto (sin cambio de estado) no toca el cobro y no requiere motivo', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValue(rpcOk(['nombre']));
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'Ana María' }));
    expect(res.statusCode).toBe(200);
    expect(llamadasRpc()[0]).toMatchObject({ p_cambios: { nombre: 'Ana María' }, p_motivo: null });
    expect(mockEjecutar).not.toHaveBeenCalled();
  });

  it('cambio de status SIN motivo → 400; membresia_tier → 400; desbloqueo sin motivo → 400. Sin RPC.', async () => {
    setCallerTarget();
    expect((await invocar(evento({ usuario_id: 'm-1', status: 'suspendido' }))).statusCode).toBe(400);
    setCallerTarget();
    expect((await invocar(evento({ usuario_id: 'm-1', membresia_tier: 'pro', motivo: 'Pagó' }))).statusCode).toBe(400);
    setCallerTarget();
    expect((await invocar(evento({ usuario_id: 'm-1', membresia_tier: null, motivo: 'Baja' }))).statusCode).toBe(400);
    setCallerTarget();
    expect((await invocar(evento({ usuario_id: 'm-1', unblock: true }))).statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('desbloqueo CON motivo viaja como { unblock: true } (la RPC conserva no_shows_count — B4)', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValue(rpcOk(['desbloqueo']));
    const res = await invocar(evento({ usuario_id: 'm-1', unblock: true, motivo: 'Avisó con tiempo' }));
    expect(res.statusCode).toBe(200);
    expect(llamadasRpc()[0]).toMatchObject({ p_cambios: { unblock: true }, p_motivo: 'Avisó con tiempo' });
  });

  it('un miembro NO puede usar la función (403); un recepcionista REVOCADO tampoco', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    expect((await invocar(evento({ usuario_id: 'm-1', nombre: 'X' }))).statusCode).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, status: 'revocado' }, error: null });
    expect((await invocar(evento({ usuario_id: 'm-1', nombre: 'X' }))).statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('escalada: recepción no edita cuentas del equipo (403, sin tocar Auth ni la RPC); un admin sí', async () => {
    setCallerTarget({ ...TARGET, id: 'a-1', rol: 'admin', email: 'jefe@cravia.mx' });
    expect((await invocar(evento({ usuario_id: 'a-1', email: 'robo@x.mx' }))).statusCode).toBe(403);
    setCallerTarget({ ...TARGET, id: 'r-2', rol: 'recepcionista' });
    expect((await invocar(evento({ usuario_id: 'r-2', status: 'suspendido', motivo: 'Celos' }))).statusCode).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    setCallerTarget({ ...TARGET, id: 'r-2', rol: 'recepcionista' }, { ...CALLER, id: 'u-admin', rol: 'admin' });
    mockRpc.mockResolvedValue(rpcOk(['nombre']));
    expect((await invocar(evento({ usuario_id: 'r-2', nombre: 'Nuevo nombre' }))).statusCode).toBe(200);
  });

  it('correo: primero Auth, después la copia local por la RPC (así el reintento converge)', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValue(rpcOk(['email']));
    const res = await invocar(evento({ usuario_id: 'm-1', email: 'Nueva@Cravia.mx' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith('auth-m1', { email: 'nueva@cravia.mx', email_confirm: true });
    expect(mockRpc).toHaveBeenCalledWith('staff_actualizar_cuenta', expect.objectContaining({ p_cambios: { email: 'nueva@cravia.mx' } }));
    expect(mockUpdateUserById.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
  });

  it('correo igual al actual o inválido: ni Auth ni RPC / 400', async () => {
    setCallerTarget();
    expect((await invocar(evento({ usuario_id: 'm-1', email: 'ANA@cravia.mx' }))).statusCode).toBe(200);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    setCallerTarget();
    expect((await invocar(evento({ usuario_id: 'm-1', email: 'sin-arroba' }))).statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('Auth rechaza el correo y no había otros cambios → 400 "ya existe" / 500, sin RPC', async () => {
    setCallerTarget();
    mockUpdateUserById.mockResolvedValue({ error: { message: 'A user with this email address has already been registered' } });
    const res = await invocar(evento({ usuario_id: 'm-1', email: 'otro@cravia.mx' }));
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('parcial honesto: nombre guardado pero Auth rechazó el correo → 409 con lo que SÍ se aplicó', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValueOnce(rpcOk(['nombre']));
    mockUpdateUserById.mockResolvedValue({ error: { message: 'already registered' } });
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'Ana María', email: 'otro@cravia.mx' }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/Se guardó nombre/);
    expect(body.parcial).toEqual({ aplicado: ['nombre'], email: 'no_aplicado' });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('parcial honesto: Auth aceptó el correo pero la copia local falló → 500 con `parcial` (nunca "nada pasó")', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const res = await invocar(evento({ usuario_id: 'm-1', email: 'otro@cravia.mx' }));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/ya cambió/);
    expect(body.parcial).toMatchObject({ email: 'auth_actualizado_perfil_pendiente' });
    expect(mockReportarError).toHaveBeenCalled();
  });

  it('la RPC rechaza con un código EKKO_* → se traduce con su texto; un error desconocido → 500 genérico', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_MOTIVO_REQUERIDO: Motivo obligatorio para esta acción' } });
    let res = await invocar(evento({ usuario_id: 'm-1', status: 'suspendido', motivo: 'Daños' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Motivo obligatorio para esta acción');
    expect(mockEjecutar).not.toHaveBeenCalled();
    setCallerTarget();
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'deadlock detected' } });
    res = await invocar(evento({ usuario_id: 'm-1', nombre: 'X' }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).not.toMatch(/deadlock/);
  });

  it('revocación: recepción NO la levanta (403, sin RPC); un admin sí, y la restauración ocurre dentro de la RPC', async () => {
    setCallerTarget({ ...TARGET, status: 'revocado' });
    expect((await invocar(evento({ usuario_id: 'm-1', status: 'activo', motivo: 'Volvió' }))).statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
    setCallerTarget({ ...TARGET, status: 'revocado' }, { ...CALLER, id: 'u-admin', rol: 'admin' });
    mockRpc.mockResolvedValue(rpcOk(['status→activo'], 'activo'));
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'activo', motivo: 'Revocación por error' }));
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('staff_actualizar_cuenta', expect.objectContaining({ p_actor_id: 'u-admin', p_cambios: { status: 'activo' } }));
    expect(JSON.parse(res.body).status).toBe('activo');
  });

  it('foto: se sube a Storage ANTES de la transacción local y la URL viaja a la RPC', async () => {
    setCallerTarget();
    mockRpc.mockResolvedValue({ data: { success: true, sin_cambios: false, cambios: ['foto'], status: 'activo', avatar_url: 'https://cdn.test/a.jpg' }, error: null });
    const res = await invocar(evento({ usuario_id: 'm-1', avatar: { base64: Buffer.from('img').toString('base64'), contentType: 'image/jpeg' } }));
    expect(res.statusCode).toBe(200);
    expect(mockUpload.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
    expect(llamadasRpc()[0]).toMatchObject({ p_cambios: { avatar_url: 'https://cdn.test/a.jpg' } });
    expect(JSON.parse(res.body).avatar_url).toBe('https://cdn.test/a.jpg');
  });

  it('sin cambios → 200 sin_cambios, sin RPC ni Auth', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, sin_cambios: true });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
