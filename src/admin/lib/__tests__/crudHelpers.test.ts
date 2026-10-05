import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

import { supabase } from '@shared/lib/supabase';
import {
  generateUniqueSlug,
  canHardDeleteRecurso,
  canHardDeleteTier,
  canModifyTeamMember,
  cancelarReserva
} from '../crudHelpers';

describe('generateUniqueSlug', () => {
  it('agrega -copia cuando no hay colisión con el sufijo base', () => {
    expect(generateUniqueSlug('pro', ['basica', 'pro'])).toBe('pro-copia');
  });

  it('agrega sufijo numérico si -copia ya existe', () => {
    expect(generateUniqueSlug('pro', ['pro', 'pro-copia'])).toBe('pro-copia-2');
  });

  it('aumenta el sufijo hasta encontrar uno libre', () => {
    expect(
      generateUniqueSlug('pro', ['pro', 'pro-copia', 'pro-copia-2', 'pro-copia-3'])
    ).toBe('pro-copia-4');
  });

  it('funciona si baseSlug no está en la lista (igual sufija -copia)', () => {
    expect(generateUniqueSlug('plus', ['basica', 'pro'])).toBe('plus-copia');
  });

  it('lista vacía → primer candidato -copia', () => {
    expect(generateUniqueSlug('starter', [])).toBe('starter-copia');
  });

  it('no se confunde con slugs que solo coinciden parcialmente', () => {
    // "pro-anual" empieza con "pro" pero NO es "pro-copia"
    expect(generateUniqueSlug('pro', ['pro-anual', 'pro-mensual'])).toBe('pro-copia');
  });
});

describe('canHardDeleteRecurso', () => {
  beforeEach(() => vi.clearAllMocks());

  it('permite borrar si no hay reservas', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 0,
      error: null
    });
    const result = await canHardDeleteRecurso('abc-123');
    expect(result.canDelete).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('count_reservas_recurso', {
      p_recurso_id: 'abc-123'
    });
  });

  it('bloquea si hay reservas', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 5,
      error: null
    });
    const result = await canHardDeleteRecurso('abc-123');
    expect(result.canDelete).toBe(false);
    expect(result.count).toBe(5);
    expect(result.reason).toContain('5');
  });

  it('bloquea si hay error de BD', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { message: 'connection failed' }
    });
    const result = await canHardDeleteRecurso('abc-123');
    expect(result.canDelete).toBe(false);
    expect(result.reason).toContain('connection failed');
  });
});

describe('canHardDeleteTier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('permite borrar si no hay miembros', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 0,
      error: null
    });
    const result = await canHardDeleteTier('tier-id');
    expect(result.canDelete).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('count_miembros_tier', {
      p_tier_id: 'tier-id'
    });
  });

  it('bloquea si hay miembros activos o históricos', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 3,
      error: null
    });
    const result = await canHardDeleteTier('tier-id');
    expect(result.canDelete).toBe(false);
    expect(result.count).toBe(3);
  });
});

describe('canModifyTeamMember', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bloquea auto-modificación', async () => {
    const result = await canModifyTeamMember(
      'user-123',
      'user-123',
      'admin',
      'revoke',
      'tenant-1'
    );
    expect(result.canModify).toBe(false);
    expect(result.reason).toContain('modificarte a ti mismo');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('bloquea revocar último admin', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 1,
      error: null
    });
    const result = await canModifyTeamMember(
      'user-456',
      'user-123',
      'admin',
      'revoke',
      'tenant-1'
    );
    expect(result.canModify).toBe(false);
    expect(result.reason).toContain('último administrador');
  });

  it('permite revocar admin si hay otros activos', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 3,
      error: null
    });
    const result = await canModifyTeamMember(
      'user-456',
      'user-123',
      'admin',
      'revoke',
      'tenant-1'
    );
    expect(result.canModify).toBe(true);
  });

  it('permite revocar recepcionista sin validación de count', async () => {
    const result = await canModifyTeamMember(
      'user-456',
      'user-123',
      'recepcionista',
      'revoke',
      'tenant-1'
    );
    expect(result.canModify).toBe(true);
    // No se llama al RPC porque no aplica para recepcionistas
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('bloquea degradar último admin a recepcionista', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: 1,
      error: null
    });
    const result = await canModifyTeamMember(
      'user-456',
      'user-123',
      'admin',
      'change-role-to-recepcionista',
      'tenant-1'
    );
    expect(result.canModify).toBe(false);
    expect(result.reason).toContain('último administrador');
  });
});

/**
 * El admin cancela por la RPC `cancelar_reserva_atomic`, no con un UPDATE directo:
 * la RPC valida que siga confirmada, avisa al miembro, devuelve el crédito y deja
 * rastro. Antes se podía "cancelar" una sesión completada desde el dashboard.
 */
describe('cancelarReserva (admin)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pasa por la RPC con el motivo, y NO toca la tabla reservas', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: {}, error: null } as never);
    const r = await cancelarReserva({ reservaId: 'res-1', motivo: 'Falla eléctrica', causa: 'estudio' });
    expect(r).toEqual({ error: null });
    // R2-B (PKG-01Q): la causa viaja explícita; el servidor decide el crédito.
    expect(supabase.rpc).toHaveBeenCalledWith('cancelar_reserva_atomic', { p_reserva_id: 'res-1', p_motivo: 'Falla eléctrica', p_causa: 'estudio' });
    await cancelarReserva({ reservaId: 'res-2', motivo: 'Avisó tarde', causa: 'miembro' });
    expect(supabase.rpc).toHaveBeenLastCalledWith('cancelar_reserva_atomic', { p_reserva_id: 'res-2', p_motivo: 'Avisó tarde', p_causa: 'miembro' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each([
    ['EKKO_RESERVA_NO_CANCELABLE: La reserva no está confirmada', /ya no está confirmada/],
    ['EKKO_RESERVA_PASADA: No puedes cancelar una reserva que ya pasó', /márcala como falta/],
    ['EKKO_TENANT_DIFERENTE: La reserva pertenece a otro estudio', /No tienes permiso/],
    ['EKKO_CAUSA_REQUERIDA: Indica si la cancelación la pidió el miembro o la decide el estudio', /quién cancela/]
  ])('rechazo de la RPC "%s" → mensaje humano', async (mensaje, esperado) => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: mensaje } } as never);
    const r = await cancelarReserva({ reservaId: 'res-1', motivo: 'x', causa: 'estudio' });
    expect(r.error).toMatch(esperado);
    expect(r.error).not.toContain('EKKO_');
  });
});

