import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * qr-issue (F2 · R1, defensa en profundidad del P0-1): una cuenta revocada o
 * sancionada no obtiene QR aunque la reserva sea válida. La puerta
 * (check_in_atomic) sigue siendo la autoridad.
 */

const mockGetUser = vi.fn();
const mockUsuario = vi.fn();
const mockReserva = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = () => (table === 'usuarios' ? mockUsuario() : mockReserva());
      return c;
    })
  }))
}));

import { handler } from '../../netlify/functions/qr-issue/index';

const invocar = async () =>
  (await handler(
    { httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify({ reserva_id: 'r1' }) } as never,
    {} as never,
    () => {}
  )) as { statusCode: number; body: string };

const USUARIO = { id: 'm1', tenant_id: 't1', status: 'activo', sancionado_at: null };
const enUnaHora = () => new Date(Date.now() + 3_600_000).toISOString();
const RESERVA = () => ({ id: 'r1', tenant_id: 't1', usuario_id: 'm1', slot_inicio: enUnaHora(), slot_fin: enUnaHora(), status: 'confirmada' });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.QR_JWT_SECRET = 'secreto-de-prueba';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-m1' } }, error: null });
  mockReserva.mockResolvedValue({ data: RESERVA(), error: null });
});

describe('qr-issue', () => {
  it('miembro en regla con reserva confirmada → emite el QR', async () => {
    mockUsuario.mockResolvedValue({ data: USUARIO, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).qr_payload).toEqual(expect.any(String));
  });

  it('cuenta sancionada → 403, sin QR', async () => {
    mockUsuario.mockResolvedValue({ data: { ...USUARIO, status: 'suspendido', sancionado_at: '2026-09-01T00:00:00Z' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/suspendida por el estudio/);
    expect(mockReserva).not.toHaveBeenCalled();
  });

  it('cuenta revocada → 403, sin QR', async () => {
    mockUsuario.mockResolvedValue({ data: { ...USUARIO, status: 'revocado' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/revocado/);
  });

  it('pausa (suspendido SIN sanción) conserva el comportamiento: puede sacar el QR de una reserva ya pagada', async () => {
    mockUsuario.mockResolvedValue({ data: { ...USUARIO, status: 'suspendido' }, error: null });
    const res = await invocar();
    expect(res.statusCode).toBe(200);
  });
});
