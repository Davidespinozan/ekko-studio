import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * crear-pago-invitados: cobro in-app de N invitados extra de una reserva del
 * miembro (Stripe, tarjeta guardada). Valida propiedad de la reserva, precio
 * configurado, y crea un PaymentIntent con metadata tipo='invitados_extra'.
 */

const mockGetUser = vi.fn();
const mockSocioMaybe = vi.fn();
const mockReservaMaybe = vi.fn();
const mockTenantMaybe = vi.fn();

const mockPICreate = vi.fn();
const mockCustomerSessionCreate = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockSocioMaybe })) })) };
      }
      if (table === 'reservas') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockReservaMaybe })) })) };
      }
      if (table === 'tenants') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockTenantMaybe })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn() })) })) };
    })
  }))
}));

vi.mock('../../netlify/functions/_lib/stripe', () => ({
  getStripe: () => ({
    paymentIntents: { create: mockPICreate },
    customerSessions: { create: mockCustomerSessionCreate }
  })
}));

vi.mock('../../netlify/functions/_lib/connectBilling', () => ({
  resolverCuentaConectada: vi.fn(async () => ({ accountId: 'acct_1', chargesEnabled: true })),
  getOrCreateSocioCustomer: vi.fn(async () => 'cus_1')
}));

import { handler } from '../../netlify/functions/crear-pago-invitados/index';

type AnyEvent = Parameters<typeof handler>[0];
const evento = (body: Record<string, unknown>): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent);
const invocar = async (body: Record<string, unknown>) =>
  (await handler(evento(body), {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  mockSocioMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'miembro', email: 'm@e.com' }, error: null });
  mockReservaMaybe.mockResolvedValue({ data: { id: 'res_1', tenant_id: 't1', usuario_id: 'u1', status: 'confirmada' }, error: null });
  mockTenantMaybe.mockResolvedValue({ data: { config: { reserva: { precio_invitado_extra_centavos: 10000 } } }, error: null });
  mockCustomerSessionCreate.mockResolvedValue({ client_secret: 'cs_secret' });
  mockPICreate.mockResolvedValue({ client_secret: 'pi_secret' });
});

describe('crear-pago-invitados', () => {
  it('cantidad inválida → 400', async () => {
    const res = await invocar({ reserva_id: 'res_1', cantidad: 0 });
    expect(res.statusCode).toBe(400);
    expect(mockPICreate).not.toHaveBeenCalled();
  });

  it('reserva de otro miembro → 403', async () => {
    mockReservaMaybe.mockResolvedValue({ data: { id: 'res_1', tenant_id: 't1', usuario_id: 'otro', status: 'confirmada' }, error: null });
    const res = await invocar({ reserva_id: 'res_1', cantidad: 2 });
    expect(res.statusCode).toBe(403);
    expect(mockPICreate).not.toHaveBeenCalled();
  });

  it('precio de extra no configurado ($0) → 400', async () => {
    mockTenantMaybe.mockResolvedValue({ data: { config: { reserva: {} } }, error: null });
    const res = await invocar({ reserva_id: 'res_1', cantidad: 2 });
    expect(res.statusCode).toBe(400);
    expect(mockPICreate).not.toHaveBeenCalled();
  });

  it('no miembro → 400', async () => {
    mockSocioMaybe.mockResolvedValue({ data: { id: 'u1', tenant_id: 't1', rol: 'recepcionista', email: null }, error: null });
    const res = await invocar({ reserva_id: 'res_1', cantidad: 2 });
    expect(res.statusCode).toBe(400);
    expect(mockPICreate).not.toHaveBeenCalled();
  });

  it('happy path: PaymentIntent por cantidad × precio con metadata invitados_extra', async () => {
    const res = await invocar({ reserva_id: 'res_1', cantidad: 3 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ clientSecret: 'pi_secret', account: 'acct_1' });
    expect(mockPICreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 30000, // 3 × $100
        currency: 'mxn',
        customer: 'cus_1',
        metadata: expect.objectContaining({ tipo: 'invitados_extra', reserva_id: 'res_1', cantidad: '3', usuario_id: 'u1' })
      }),
      { stripeAccount: 'acct_1' }
    );
  });
});
