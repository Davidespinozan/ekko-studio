import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * PKG-03A · `useRevisionesFinancieras`: las abiertas nunca desaparecen por el
 * volumen de resueltas (antes: un `limit(200)` mezclado), y la ficha del miembro
 * también ve las revisiones que no vienen de un reembolso/disputa (su miembro
 * está en `detalle.usuario_id`).
 */

type Fila = { id: string; estado: string; reversal_id: string | null; detalle: Record<string, unknown>; tipo: string; abierta_at: string };
const h = vi.hoisted(() => ({
  filas: [] as Fila[],
  consultas: [] as Array<{ estado?: unknown; limite?: number }>
}));

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1' }) }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const q: { estado?: unknown; limite?: number } = {};
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.order = () => c;
      c.in = () => c;
      c.eq = (col: string, val: unknown) => { if (col === 'estado') q.estado = val; return c; };
      c.limit = (n: number) => { q.limite = n; return c; };
      c.then = (cb: (v: unknown) => unknown) => {
        if (tabla === 'revisiones_financieras') {
          h.consultas.push(q);
          let datos = h.filas.filter((f) => q.estado === undefined || f.estado === q.estado);
          if (q.limite !== undefined) datos = datos.slice(0, q.limite);
          return Promise.resolve({ data: datos, error: null }).then(cb);
        }
        if (tabla === 'usuarios') return Promise.resolve({ data: [{ id: 'u-1', nombre: 'Ana' }], error: null }).then(cb);
        return Promise.resolve({ data: [], error: null }).then(cb);
      };
      return c;
    },
    rpc: vi.fn()
  }
}));

import { useRevisionesFinancieras, LIMITE_RESUELTAS } from '../useRevisionesFinancieras';

const fila = (id: string, estado: string, extra: Partial<Fila> = {}): Fila => ({
  id, estado, reversal_id: null, detalle: {}, tipo: 'credito_no_restaurado', abierta_at: '2026-10-01T00:00:00Z', ...extra
});

beforeEach(() => {
  h.consultas = [];
  // 250 resueltas "más recientes" y UNA abierta vieja: antes no aparecía.
  h.filas = [...Array.from({ length: 250 }, (_, i) => fila(`res-${i}`, 'resuelta')), fila('abierta-vieja', 'abierta')];
});

describe('useRevisionesFinancieras (PKG-03A)', () => {
  it('la abierta vieja sigue visible aunque haya cientos de resueltas; las abiertas se piden sin límite', async () => {
    const { result } = renderHook(() => useRevisionesFinancieras());
    await waitFor(() => expect(result.current.revisiones).not.toBeNull());
    expect(result.current.revisiones!.map((r) => r.id)).toContain('abierta-vieja');
    expect(h.consultas).toEqual(expect.arrayContaining([{ estado: 'abierta' }, { estado: 'resuelta', limite: LIMITE_RESUELTAS }]));
    expect(result.current.revisiones!.filter((r) => r.estado === 'resuelta')).toHaveLength(LIMITE_RESUELTAS);
  });

  it('solo abiertas: no pide historial', async () => {
    const { result } = renderHook(() => useRevisionesFinancieras({ soloAbiertas: true }));
    await waitFor(() => expect(result.current.revisiones).not.toBeNull());
    expect(result.current.revisiones!.map((r) => r.id)).toEqual(['abierta-vieja']);
    expect(h.consultas).toEqual([{ estado: 'abierta' }]);
  });

  it('ficha del miembro: incluye las revisiones cuyo miembro viene en detalle (sin reembolso de por medio)', async () => {
    h.filas = [fila('rev-detalle', 'abierta', { detalle: { usuario_id: 'u-1' } }), fila('rev-otro', 'abierta', { detalle: { usuario_id: 'u-2' } })];
    const { result } = renderHook(() => useRevisionesFinancieras({ soloAbiertas: true, usuarioId: 'u-1' }));
    await waitFor(() => expect(result.current.revisiones).not.toBeNull());
    expect(result.current.revisiones!.map((r) => [r.id, r.usuario_id, r.miembro_nombre])).toEqual([['rev-detalle', 'u-1', 'Ana']]);
  });
});
