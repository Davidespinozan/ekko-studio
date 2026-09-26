import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Bloque A — gobernanza. Tests de la Netlify Function `reception-update-member`:
 *  - motivo OBLIGATORIO en status/tier/desbloqueo (400 si falta).
 *  - escribe audit_log por acción con antes/después correctos.
 *  - contacto NO requiere motivo.
 *  - dejó de escribir en notas_admin (B1/B2).
 *  - desbloqueo NO resetea no_shows_count (B4).
 */

const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn();
const mockAuditInsert = vi.fn();
const mockUpdateUserById = vi.fn();
const mockTierMaybeSingle = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
      admin: { updateUserById: mockUpdateUserById }
    },
    from: vi.fn((table: string) => {
      if (table === 'audit_log') return { insert: mockAuditInsert };
      // tiers: select().eq().eq().eq().maybeSingle() (validación del plan contra la DB)
      if (table === 'tiers') {
        const chain: Record<string, unknown> = { maybeSingle: mockTierMaybeSingle };
        chain.eq = vi.fn(() => chain);
        return { select: vi.fn(() => chain) };
      }
      // usuarios: soporta select().eq().maybeSingle() y update().eq()
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })),
        update: mockUpdate
      };
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn().mockResolvedValue({ error: null }),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://cdn.test/a.jpg' } }))
      }))
    }
  }))
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
const TARGET = {
  id: 'm-1',
  auth_id: 'auth-m1',
  tenant_id: 't1',
  rol: 'miembro',
  nombre: 'Ana',
  email: 'ana@cravia.mx',
  telefono: '123',
  status: 'activo',
  membresia_tier: 'basica',
  bloqueado_hasta: null,
  no_shows_count: 0
};

function setCallerTarget(target: Record<string, unknown> = TARGET) {
  mockMaybeSingle
    .mockResolvedValueOnce({ data: CALLER, error: null })
    .mockResolvedValueOnce({ data: target, error: null });
}

function patchEnviado(): Record<string, unknown> {
  return mockUpdate.mock.calls[0][0] as Record<string, unknown>;
}

function auditDe(accion: string): Record<string, unknown> | undefined {
  return mockAuditInsert.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => e.accion === accion);
}

describe('reception-update-member · gobernanza (Bloque A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = 'http://supabase.test';
    process.env.VITE_SUPABASE_ANON_KEY = 'anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-caller' } }, error: null });
    mockUpdateUserById.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    // Por defecto el plan pedido existe y está activo en el tenant.
    mockTierMaybeSingle.mockResolvedValue({ data: { slug: 'pro' }, error: null });
  });

  it('cambio de status SIN motivo → 400, sin update ni audit', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'suspendido' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('cambio de status CON motivo → 200 + audit status_change con antes/después', async () => {
    setCallerTarget();
    const res = await invocar(
      evento({ usuario_id: 'm-1', status: 'suspendido', motivo: 'Cliente solicitó suspensión' })
    );
    expect(res.statusCode).toBe(200);
    const patch = patchEnviado();
    expect(patch.status).toBe('suspendido');
    // B1/B2: ya no se escribe notas_admin.
    expect(patch).not.toHaveProperty('notas_admin');
    const audit = auditDe('status_change');
    expect(audit).toBeDefined();
    expect(audit?.antes).toEqual({ status: 'activo', sancionado: false });
    expect(audit?.despues).toEqual({ status: 'suspendido', sancionado: true });
    expect(audit?.motivo).toBe('Cliente solicitó suspensión');
    expect(audit?.actor_usuario_id).toBe('u-recep');
  });

  it('membresia_tier en el body → 400 sin update (el plan se activa con cobro, no desde "Editar datos")', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', membresia_tier: 'pro', motivo: 'Compró paquete' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockTierMaybeSingle).not.toHaveBeenCalled();
  });

  it('membresia_tier: null tampoco (quitar el plan a mano cancelaba la membresía local y no la de Stripe)', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', membresia_tier: null, motivo: 'Baja voluntaria' }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('edición de contacto NO requiere motivo → 200 + audit contact_change', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'Ana María' }));
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    const patch = patchEnviado();
    expect(patch.nombre).toBe('Ana María');
    expect(patch).not.toHaveProperty('notas_admin');
    expect(auditDe('contact_change')).toBeDefined();
  });

  it('desbloqueo CON motivo: bloqueado_hasta=null y NO resetea no_shows_count (B4)', async () => {
    setCallerTarget({ ...TARGET, bloqueado_hasta: '2099-01-01T00:00:00Z', no_shows_count: 3 });
    const res = await invocar(
      evento({ usuario_id: 'm-1', unblock: true, motivo: 'Error operativo (no fue no-show real)' })
    );
    expect(res.statusCode).toBe(200);
    const patch = patchEnviado();
    expect(patch.bloqueado_hasta).toBeNull();
    expect(patch).not.toHaveProperty('no_shows_count'); // B4: no se toca
    const audit = auditDe('unblock');
    expect(audit).toBeDefined();
    expect((audit?.despues as Record<string, unknown>).no_shows_count).toBe(3); // conservado
  });

  it('desbloqueo SIN motivo → 400', async () => {
    setCallerTarget({ ...TARGET, bloqueado_hasta: '2099-01-01T00:00:00Z', no_shows_count: 3 });
    const res = await invocar(evento({ usuario_id: 'm-1', unblock: true }));
    expect(res.statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('un miembro NO puede usar la función (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...CALLER, rol: 'miembro' },
      error: null
    });
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'X' }));
    expect(res.statusCode).toBe(403);
  });

  it('un recepcionista REVOCADO no puede usar la función aunque conserve su sesión (403)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { ...CALLER, status: 'revocado' },
      error: null
    });
    const res = await invocar(evento({ usuario_id: 'm-1', nombre: 'X' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('escalada: un recepcionista NO puede cambiarle el email de acceso a un admin (403, sin tocar auth)', async () => {
    setCallerTarget({ ...TARGET, id: 'a-1', auth_id: 'auth-admin', rol: 'admin', email: 'dueno@ekko.mx' });
    const res = await invocar(evento({ usuario_id: 'a-1', email: 'atacante@evil.mx' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('escalada: un recepcionista tampoco puede suspender a otro miembro del equipo (403)', async () => {
    setCallerTarget({ ...TARGET, id: 'r-2', rol: 'recepcionista' });
    const res = await invocar(evento({ usuario_id: 'r-2', status: 'suspendido', motivo: 'porque sí' }));
    expect(res.statusCode).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('un admin SÍ puede editar una cuenta del equipo', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...CALLER, id: 'u-admin', rol: 'admin' }, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: { ...TARGET, id: 'r-2', rol: 'recepcionista' }, error: null });
    const res = await invocar(evento({ usuario_id: 'r-2', nombre: 'Nuevo Nombre' }));
    expect(res.statusCode).toBe(200);
  });


  it('suspender desde el mostrador = sanción: fija sancionado_at + motivo en el MISMO update', async () => {
    setCallerTarget();
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'suspendido', motivo: 'Daños al equipo' }));
    expect(res.statusCode).toBe(200);
    const patch = patchEnviado();
    expect(patch.status).toBe('suspendido');
    expect(typeof patch.sancionado_at).toBe('string');
    expect(patch.sancion_motivo).toBe('Daños al equipo');
    expect(auditDe('status_change')?.despues).toEqual({ status: 'suspendido', sancionado: true });
  });

  it('reactivar levanta la sanción: sancionado_at y motivo a NULL junto con status=activo', async () => {
    setCallerTarget({ ...TARGET, status: 'suspendido', sancionado_at: '2026-09-01T00:00:00Z' });
    const res = await invocar(evento({ usuario_id: 'm-1', status: 'activo', motivo: 'Pagó los daños' }));
    expect(res.statusCode).toBe(200);
    const patch = patchEnviado();
    expect(patch).toMatchObject({ status: 'activo', sancionado_at: null, sancion_motivo: null });
    expect(auditDe('status_change')?.antes).toEqual({ status: 'suspendido', sancionado: true });
  });
});
