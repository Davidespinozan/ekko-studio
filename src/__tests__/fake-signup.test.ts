import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests de seguridad de la Netlify Function `fake-signup` (SEC-FIX C1).
 *
 * El agujero original: endpoint público SIN autenticación que, con
 * `service_role`, creaba cuentas `status='activo'` + un `payment_event`
 * 'fake_succeeded' → cualquiera con `curl` se daba de alta una cuenta
 * activa ilimitada, gratis (bypass de monetización).
 *
 * El fix: la cuenta nace `pendiente_pago` (inerte — el RPC de reserva
 * exige `status='activo'`) y NO se finge ningún pago.
 */

const mockCreateUser = vi.fn();
const mockDeleteUser = vi.fn();
const tablasTocadas: string[] = [];
const updatePayloads: Record<string, unknown>[] = [];

interface QueryBuilder {
  select: () => QueryBuilder;
  eq: () => QueryBuilder;
  update: (payload: Record<string, unknown>) => QueryBuilder;
  insert: () => Promise<{ error: null }>;
  single: () => Promise<{ data: Record<string, unknown> | null; error: null }>;
}

function builder(tabla: string): QueryBuilder {
  const b: QueryBuilder = {
    select: () => b,
    eq: () => b,
    update: (payload) => {
      updatePayloads.push(payload);
      return b;
    },
    insert: () => Promise.resolve({ error: null }),
    single: () => {
      if (tabla === 'tenants') return Promise.resolve({ data: { id: 'tenant-ekko' }, error: null });
      if (tabla === 'tiers') return Promise.resolve({ data: { slug: 'pro' }, error: null });
      if (tabla === 'usuarios') return Promise.resolve({ data: { id: 'u-nuevo' }, error: null });
      return Promise.resolve({ data: null, error: null });
    }
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { admin: { createUser: mockCreateUser, deleteUser: mockDeleteUser } },
    from: vi.fn((tabla: string) => {
      tablasTocadas.push(tabla);
      return builder(tabla);
    })
  }))
}));

import { handler } from '../../netlify/functions/fake-signup';

type AnyEvent = Parameters<typeof handler>[0];

const BODY_OK = { nombre: 'Cliente Nuevo', email: 'nuevo@x.com', password: 'password123', tier: 'pro' };

function evento(body: unknown): AnyEvent {
  return { httpMethod: 'POST', headers: {}, body: JSON.stringify(body) } as unknown as AnyEvent;
}

async function invocar(event: AnyEvent) {
  const res = await handler(event, {} as never, () => {});
  return res as { statusCode: number; body: string };
}

describe('fake-signup · SEC-FIX C1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tablasTocadas.length = 0;
    updatePayloads.length = 0;
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockCreateUser.mockResolvedValue({ data: { user: { id: 'auth-nuevo' } }, error: null });
  });

  it('crea la cuenta como pendiente_pago — NUNCA activo', async () => {
    const res = await invocar(evento(BODY_OK));
    expect(res.statusCode).toBe(200);

    const updateUsuarios = updatePayloads[0];
    expect(updateUsuarios.status).toBe('pendiente_pago');
    expect(updateUsuarios.status).not.toBe('activo');
  });

  it('NO inserta en payment_events — no finge un pago', async () => {
    await invocar(evento(BODY_OK));
    expect(tablasTocadas).not.toContain('payment_events');
  });

  it('rechaza método que no sea POST', async () => {
    const res = await invocar({ httpMethod: 'GET', headers: {}, body: null } as unknown as AnyEvent);
    expect(res.statusCode).toBe(405);
  });
});
