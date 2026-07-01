import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * reception-datos-identidad (POST): guarda la ficha y recalcula identidad_completa
 * (foto + nacimiento + domicilio + INE). Gate de rol y cross-tenant.
 */

const mockGetUser = vi.fn();
const mockUsuariosMaybe = vi.fn();
const mockUsuariosUpdateEq = vi.fn().mockResolvedValue({ error: null });
const mockDpMaybe = vi.fn();
const mockDpUpsert = vi.fn().mockResolvedValue({ error: null });
const mockAuditInsert = vi.fn().mockResolvedValue({ error: null });
const mockUpload = vi.fn().mockResolvedValue({ error: null });
const mockSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed' } });

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === 'usuarios') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockUsuariosMaybe })) })),
          update: vi.fn(() => ({ eq: mockUsuariosUpdateEq }))
        };
      }
      if (table === 'usuarios_datos_privados') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockDpMaybe })) })),
          upsert: mockDpUpsert
        };
      }
      return { insert: mockAuditInsert };
    }),
    storage: { from: vi.fn(() => ({ upload: mockUpload, createSignedUrl: mockSignedUrl })) }
  }))
}));

import { handler } from '../../netlify/functions/reception-datos-identidad/index';

type AnyEvent = Parameters<typeof handler>[0];
const post = (body: unknown): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent);
const invocar = async (e: AnyEvent) => (await handler(e, {} as never, () => {})) as { statusCode: number; body: string };

const CALLER = { id: 'u1', tenant_id: 't1', rol: 'recepcionista' };
const TARGET = { id: 'm1', tenant_id: 't1', avatar_url: 'http://a/x.jpg', identidad_completa: false, contrato_firmado: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockUsuariosUpdateEq.mockResolvedValue({ error: null });
  mockDpUpsert.mockResolvedValue({ error: null });
  mockAuditInsert.mockResolvedValue({ error: null });
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
});

describe('reception-datos-identidad', () => {
  it('no-staff → 403', async () => {
    mockUsuariosMaybe.mockResolvedValueOnce({ data: { ...CALLER, rol: 'miembro' }, error: null });
    const res = await invocar(post({ usuario_id: 'm1' }));
    expect(res.statusCode).toBe(403);
  });

  it('otro tenant → 403', async () => {
    mockUsuariosMaybe
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: { ...TARGET, tenant_id: 't2' }, error: null });
    const res = await invocar(post({ usuario_id: 'm1' }));
    expect(res.statusCode).toBe(403);
  });

  it('con foto+nacimiento+domicilio+INE previa → identidad_completa true + contrato', async () => {
    mockUsuariosMaybe
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });
    mockDpMaybe.mockResolvedValue({ data: { ine_foto_path: 't1/m1-ine.jpg' }, error: null });

    const res = await invocar(post({
      usuario_id: 'm1',
      fecha_nacimiento: '1995-05-10',
      domicilio: 'Calle 123',
      contrato_firmado: true
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.identidad_completa).toBe(true);
    expect(body.contrato_firmado).toBe(true);
    expect(mockDpUpsert).toHaveBeenCalled();
    expect(mockUsuariosUpdateEq).toHaveBeenCalled();
  });

  it('falta domicilio → identidad_completa false', async () => {
    mockUsuariosMaybe
      .mockResolvedValueOnce({ data: CALLER, error: null })
      .mockResolvedValueOnce({ data: TARGET, error: null });
    mockDpMaybe.mockResolvedValue({ data: { ine_foto_path: 't1/m1-ine.jpg' }, error: null });

    const res = await invocar(post({ usuario_id: 'm1', fecha_nacimiento: '1995-05-10' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).identidad_completa).toBe(false);
  });
});
