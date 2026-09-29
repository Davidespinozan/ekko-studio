import { describe, it, expect, vi, beforeEach } from 'vitest';

/** PKG-02A (C02 · F22) — el conteo de miembros de un plan es `null` (desconocido) si alguna consulta falla; nunca 0. */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, { data: unknown; error: unknown }>
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select']) c[m] = () => c;
      c.eq = () => c;
      c.then = (cb: (v: unknown) => unknown) => Promise.resolve(h.porTabla[tabla] ?? { data: [], error: null }).then(cb);
      return c;
    }
  }
}));

import { countActiveMembersInTier } from '../crudHelpers';

const params = { tierId: 't1', tierSlug: 'pro', tenantId: 'ten' };

describe('countActiveMembersInTier (PKG-02A)', () => {
  beforeEach(() => {
    h.porTabla = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success → conteo real sin doble conteo', async () => {
    h.porTabla.membresias = { data: [{ usuario_id: 'u1' }, { usuario_id: 'u2' }], error: null };
    h.porTabla.usuarios = { data: [{ id: 'u2' }, { id: 'u3' }], error: null };
    expect(await countActiveMembersInTier(params)).toBe(3);
  });

  it('success vacío → 0 real', async () => {
    expect(await countActiveMembersInTier(params)).toBe(0);
  });

  it('falla membresias → null (desconocido), aunque usuarios haya respondido', async () => {
    h.porTabla.membresias = { data: null, error: { message: 'permission denied' } };
    h.porTabla.usuarios = { data: [{ id: 'u3' }], error: null };
    expect(await countActiveMembersInTier(params)).toBeNull();
  });

  it('falla usuarios → null', async () => {
    h.porTabla.usuarios = { data: null, error: { message: 'timeout' } };
    expect(await countActiveMembersInTier(params)).toBeNull();
  });
});
