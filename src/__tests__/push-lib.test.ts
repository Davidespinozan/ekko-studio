import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Helper de entrega push (`enviarPushAUsuario`): fan-out a todos los dispositivos
 * del usuario y borrado de suscripciones muertas (404/410).
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: mockSend }
}));

const mockSelectEq = vi.fn();
const mockDeleteIn = vi.fn().mockResolvedValue({ error: null });
const admin = {
  from: vi.fn(() => ({
    select: vi.fn(() => ({ eq: mockSelectEq })),
    delete: vi.fn(() => ({ in: mockDeleteIn }))
  }))
} as unknown as Parameters<typeof enviarPushAUsuario>[0];

import { enviarPushAUsuario } from '../../netlify/functions/_lib/push';

const SUB = (id: string) => ({ id, endpoint: `https://push/${id}`, p256dh: 'p', auth: 'a' });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  mockDeleteIn.mockResolvedValue({ error: null });
});

describe('enviarPushAUsuario', () => {
  it('envía a todos los dispositivos del usuario', async () => {
    mockSelectEq.mockResolvedValue({ data: [SUB('s1'), SUB('s2')], error: null });
    mockSend.mockResolvedValue(undefined);

    const r = await enviarPushAUsuario(admin, 'u1', { titulo: 'Hola', mensaje: 'Test' });
    expect(r.enviados).toBe(2);
    expect(r.borrados).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('borra la suscripción muerta (410) y sigue con las demás', async () => {
    mockSelectEq.mockResolvedValue({ data: [SUB('viva'), SUB('muerta')], error: null });
    mockSend.mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('muerta')) return Promise.reject({ statusCode: 410 });
      return Promise.resolve(undefined);
    });

    const r = await enviarPushAUsuario(admin, 'u1', { titulo: 'x', mensaje: 'y' });
    expect(r.enviados).toBe(1);
    expect(r.borrados).toBe(1);
    expect(mockDeleteIn).toHaveBeenCalledWith('id', ['muerta']);
  });

  it('sin suscripciones → no envía', async () => {
    mockSelectEq.mockResolvedValue({ data: [], error: null });
    const r = await enviarPushAUsuario(admin, 'u1', { titulo: 'x', mensaje: 'y' });
    expect(r.enviados).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
