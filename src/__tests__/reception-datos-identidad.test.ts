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

import { handler, fusionarCampo } from '../../netlify/functions/reception-datos-identidad/index';

type AnyEvent = Parameters<typeof handler>[0];
const post = (body: unknown): AnyEvent =>
  ({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent);
const invocar = async (e: AnyEvent) => (await handler(e, {} as never, () => {})) as { statusCode: number; body: string };

const CALLER = { id: 'u1', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
const TARGET = { id: 'm1', tenant_id: 't1', rol: 'miembro', avatar_url: 'http://a/x.jpg', identidad_completa: false, contrato_firmado: false };

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

  // ── Fase 1 identidad: PATCH, nunca sobrescritura ──────────────────────────
  describe('semántica PATCH (Fase 1 identidad)', () => {
    const PREV = { fecha_nacimiento: '1990-05-05', domicilio: 'Calle 1', ine_folio: 'ABC123', ine_foto_path: 't1/m1-ine.jpg' };
    const conFicha = (target: Record<string, unknown> = TARGET) => {
      mockUsuariosMaybe
        .mockResolvedValueOnce({ data: CALLER, error: null })
        .mockResolvedValueOnce({ data: target, error: null });
      mockDpMaybe.mockResolvedValueOnce({ data: PREV, error: null });
    };
    const upsertEnviado = () => mockDpUpsert.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const patchUsuarios = () => {
      const fromMock = (mockUsuariosUpdateEq.mock.calls.length, null);
      return fromMock;
    };

    it('campo omitido → conserva el valor actual (antes quedaba en NULL)', async () => {
      conFicha();
      const res = await invocar(post({ usuario_id: 'm1', domicilio: 'Calle 2' }));
      expect(res.statusCode).toBe(200);
      expect(upsertEnviado()).toMatchObject({
        fecha_nacimiento: '1990-05-05',
        domicilio: 'Calle 2',
        ine_folio: 'ABC123',
        ine_foto_path: 't1/m1-ine.jpg'
      });
      expect(JSON.parse(res.body).cambios).toEqual(['domicilio']);
    });

    it('un POST con todos los campos ausentes o vacíos no escribe nada en la ficha', async () => {
      conFicha();
      const res = await invocar(post({ usuario_id: 'm1', fecha_nacimiento: '', domicilio: '   ' }));
      expect(res.statusCode).toBe(200);
      expect(mockDpUpsert).not.toHaveBeenCalled();
      expect(JSON.parse(res.body).cambios).toEqual([]);
    });

    it('null explícito borra; string vacío no', () => {
      expect(fusionarCampo(null, 'x')).toEqual({ valor: null, cambio: true });
      expect(fusionarCampo('', 'x')).toEqual({ valor: 'x', cambio: false });
      expect(fusionarCampo(undefined, 'x')).toEqual({ valor: 'x', cambio: false });
      expect(fusionarCampo('  y ', 'x')).toEqual({ valor: 'y', cambio: true });
      expect(fusionarCampo('x', 'x')).toEqual({ valor: 'x', cambio: false });
    });

    it('fecha con formato inválido → 400 sin escribir', async () => {
      conFicha();
      const res = await invocar(post({ usuario_id: 'm1', fecha_nacimiento: '05/05/1990' }));
      expect(res.statusCode).toBe(400);
      expect(mockDpUpsert).not.toHaveBeenCalled();
    });

    it('contrato ya firmado + guardar otra cosa → NO reescribe contrato_firmado_at', async () => {
      conFicha({ ...TARGET, identidad_completa: true, contrato_firmado: true });
      const res = await invocar(post({ usuario_id: 'm1', domicilio: 'Calle 3', contrato_firmado: true }));
      expect(res.statusCode).toBe(200);
      // identidad_completa no cambió y el contrato ya estaba: no hay update a usuarios.
      expect(mockUsuariosUpdateEq).not.toHaveBeenCalled();
      expect(JSON.parse(res.body)).toMatchObject({ contrato_firmado: true, cambios: ['domicilio'] });
    });

    it('contrato false→true fija contrato_firmado_at una sola vez', async () => {
      conFicha({ ...TARGET, identidad_completa: true, contrato_firmado: false });
      const res = await invocar(post({ usuario_id: 'm1', contrato_firmado: true }));
      expect(res.statusCode).toBe(200);
      expect(mockUsuariosUpdateEq).toHaveBeenCalledTimes(1);
      expect(JSON.parse(res.body)).toMatchObject({ contrato_firmado: true, cambios: ['contrato_firmado'] });
    });

    it('desmarcar un contrato firmado NO borra la fecha: se ignora y se avisa', async () => {
      conFicha({ ...TARGET, identidad_completa: true, contrato_firmado: true });
      const res = await invocar(post({ usuario_id: 'm1', contrato_firmado: false }));
      expect(res.statusCode).toBe(200);
      expect(mockUsuariosUpdateEq).not.toHaveBeenCalled();
      const body = JSON.parse(res.body);
      expect(body.contrato_firmado).toBe(true);
      expect(body.aviso).toMatch(/ya estaba firmado/i);
    });

    it('identidad_completa se recalcula con los valores FUSIONADOS (foto + ficha previa completa → true)', async () => {
      conFicha({ ...TARGET, identidad_completa: false, contrato_firmado: false });
      const res = await invocar(post({ usuario_id: 'm1', ine_folio: 'NUEVO1' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).identidad_completa).toBe(true);
      expect(mockUsuariosUpdateEq).toHaveBeenCalledTimes(1);
    });

    void patchUsuarios;
  });
});
