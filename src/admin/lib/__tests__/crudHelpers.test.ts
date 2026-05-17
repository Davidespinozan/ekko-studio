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
  canHardDeleteTier
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
