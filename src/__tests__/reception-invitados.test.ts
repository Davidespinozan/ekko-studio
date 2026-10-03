import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-01H (W-3=A) · `reception-invitados`: el servidor decide. El alta pasa por la
 * RPC `registrar_ficha_invitado` (lock de la reserva, tope = incluidos + extras
 * pagados, ventana de asistencia, es_extra desde la reserva). Si la RPC rechaza
 * después de subir la foto, la foto se borra. El listado sale del snapshot de la
 * reserva, no del plan cacheado del miembro.
 */

const h = vi.hoisted(() => ({
  caller: { id: 'staff1', tenant_id: 't1', rol: 'recepcionista', status: 'activo' } as Record<string, unknown> | null,
  reserva: { id: 'r1', tenant_id: 't1', usuario_id: 'u1', invitados_count: 2, invitados_extra_pagados: 1 } as Record<string, unknown> | null,
  fichas: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  audit: vi.fn(),
  consultasUsuarios: 0
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'auth1' } }, error: null }) },
    rpc: (...a: unknown[]) => h.rpc(...a),
    storage: {
      from: () => ({
        upload: (...a: unknown[]) => h.upload(...a),
        remove: (...a: unknown[]) => h.remove(...a),
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://x/firmada' } })
      })
    },
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'order', 'insert', 'delete']) c[k] = () => c;
      if (tabla === 'audit_log') {
        c.insert = (...a: unknown[]) => { h.audit(...a); return Promise.resolve({ error: null }); };
      }
      c.maybeSingle = () => {
        if (tabla === 'usuarios') { h.consultasUsuarios++; return Promise.resolve({ data: h.caller, error: null }); }
        if (tabla === 'reservas') return Promise.resolve({ data: h.reserva, error: null });
        if (tabla === 'tenants') return Promise.resolve({ data: { config: { reserva: { precio_invitado_extra_centavos: 10000 } } }, error: null });
        return Promise.resolve({ data: null, error: null });
      };
      c.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: tabla === 'reserva_invitados' ? h.fichas : [], error: null }).then(cb);
      return c;
    }
  }))
}));

import { handler } from '../../netlify/functions/reception-invitados/index';

type AnyEvent = Parameters<typeof handler>[0];
const invocar = async (body: unknown) =>
  (await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer tok' }, body: JSON.stringify(body) } as unknown as AnyEvent, {} as never, () => {})) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  h.caller = { id: 'staff1', tenant_id: 't1', rol: 'recepcionista', status: 'activo' };
  h.reserva = { id: 'r1', tenant_id: 't1', usuario_id: 'u1', invitados_count: 2, invitados_extra_pagados: 1 };
  h.fichas = [];
  h.consultasUsuarios = 0;
  h.upload.mockResolvedValue({ error: null });
  h.remove.mockResolvedValue({ error: null });
  h.rpc.mockResolvedValue({ data: { success: true, invitado_id: 'g1', es_extra: false, registrados: 1, cubiertos: 3 }, error: null });
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
});

describe('reception-invitados (PKG-01H)', () => {
  it('list: cobertura desde la RESERVA (2 incluidos + 1 extra pagado = 3), sin consultar el plan cacheado del miembro', async () => {
    h.fichas = [{ id: 'g1', nombre: 'Ana', foto_path: null, es_extra: false, created_at: '2026-10-03T10:00:00Z' }];
    const res = await invocar({ action: 'list', reserva_id: 'r1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ max_incluidos: 2, invitados_extra_pagados: 1, cubiertos: 3, disponibles: 2, total: 1, extras: 0 });
    // Solo se consultó usuarios para el caller (no el membresia_tier del miembro).
    expect(h.consultasUsuarios).toBe(1);
  });

  it('add: delega en registrar_ficha_invitado con actor, reserva, nombre y foto; audita con es_extra que devolvió el servidor', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, invitado_id: 'g9', es_extra: true }, error: null });
    const res = await invocar({ action: 'add', reserva_id: 'r1', nombre: '  Beto  ', foto: { base64: Buffer.from('img').toString('base64'), contentType: 'image/jpeg' } });
    expect(res.statusCode).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith('registrar_ficha_invitado', expect.objectContaining({ p_actor_id: 'staff1', p_reserva_id: 'r1', p_nombre: 'Beto', p_foto_path: expect.stringMatching(/^invitados\/t1\/r1\/.+\.jpg$/) }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ accion: 'invitado_agregado', despues: { invitado_id: 'g9', es_extra: true } }));
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('add por encima de lo cubierto → 409 invitados_no_cubiertos y se BORRA la foto ya subida; sin auditoría', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_INVITADOS_NO_CUBIERTOS: La reserva cubre 3 invitado(s) y ya están registrados' } });
    const res = await invocar({ action: 'add', reserva_id: 'r1', nombre: 'Cuarto', foto: { base64: Buffer.from('img').toString('base64'), contentType: 'image/png' } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('invitados_no_cubiertos');
    expect(h.remove).toHaveBeenCalledWith([expect.stringMatching(/\.png$/)]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('add en reserva no vigente / pasada → 409 con código; de otro estudio → 403', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_RESERVA_NO_VIGENTE: x' } });
    expect(JSON.parse((await invocar({ action: 'add', reserva_id: 'r1', nombre: 'Ana' })).body).code).toBe('reserva_no_vigente');
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'EKKO_RESERVA_PASADA: x' } });
    expect(JSON.parse((await invocar({ action: 'add', reserva_id: 'r1', nombre: 'Ana' })).body).code).toBe('reserva_pasada');
    h.reserva = { ...h.reserva!, tenant_id: 'otro' };
    const res = await invocar({ action: 'add', reserva_id: 'r1', nombre: 'Ana' });
    expect(res.statusCode).toBe(403);
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it('miembro (no staff) → 403 sin tocar nada', async () => {
    h.caller = { id: 'u1', tenant_id: 't1', rol: 'miembro', status: 'activo' };
    const res = await invocar({ action: 'add', reserva_id: 'r1', nombre: 'Ana' });
    expect(res.statusCode).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });
});
