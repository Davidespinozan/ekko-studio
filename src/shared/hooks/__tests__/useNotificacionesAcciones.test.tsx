import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * La campana es un HISTORIAL: leídos y no leídos, "marcar todas" de verdad, revertir
 * si el servidor falla, y nunca apagar el gate de "cambia tu contraseña temporal".
 */

const h = vi.hoisted(() => ({
  filas: [] as Record<string, unknown>[],
  updates: [] as { patch: unknown; filtros: string[] }[],
  errorAlGuardar: false,
  // Estable entre renders, como en producción (si cambiara, el hook recargaría).
  usuario: { id: 'user-1', tenant_id: 't1' }
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.order = () => q;
      q.eq = () => q;
      q.limit = () => Promise.resolve({ data: h.filas, error: null });
      q.update = (patch: unknown) => {
        const reg = { patch, filtros: [] as string[] };
        h.updates.push(reg);
        const u: Record<string, unknown> = {};
        u.eq = (c: string, v: unknown) => { reg.filtros.push(`${c}=${v}`); return u; };
        u.not = (c: string, op: string, v: unknown) => { reg.filtros.push(`not ${c} ${op} ${v}`); return u; };
        u.then = (cb: (v: unknown) => unknown) =>
          Promise.resolve({ error: h.errorAlGuardar ? { message: 'rls' } : null }).then(cb);
        return u;
      };
      return q;
    }
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: h.usuario }) }));

import { useNotificacionesMiembro } from '../useNotificacionesMiembro';

const aviso = (id: string, extra: Record<string, unknown> = {}) => ({
  id, tipo: 'reserva_confirmada', titulo: 'Reserva confirmada', mensaje: 'x', metadata: null, creada_at: '2026-09-20T00:00:00Z', leida: false, ...extra
});

async function montar() {
  const r = renderHook(() => useNotificacionesMiembro());
  await waitFor(() => expect(r.result.current.notificaciones.length).toBe(h.filas.length));
  return r;
}

beforeEach(() => {
  h.filas = [];
  h.updates = [];
  h.errorAlGuardar = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useNotificacionesMiembro — historial', () => {
  it('trae leídos Y no leídos; el contador solo cuenta los no leídos', async () => {
    h.filas = [aviso('a'), aviso('b', { leida: true }), aviso('c')];
    const { result } = await montar();
    expect(result.current.notificaciones).toHaveLength(3);
    expect(result.current.noLeidas).toBe(2);
  });

  it('marcar leída NO la saca de la lista: queda atenuada', async () => {
    h.filas = [aviso('a'), aviso('b')];
    const { result } = await montar();
    await act(async () => { await result.current.marcarLeida('a'); });
    expect(result.current.notificaciones.map((n) => [n.id, n.leida])).toEqual([['a', true], ['b', false]]);
    expect(result.current.noLeidas).toBe(1);
  });

  it('si el servidor no lo guarda, se REVIERTE', async () => {
    h.filas = [aviso('a')];
    h.errorAlGuardar = true;
    const { result } = await montar();
    await act(async () => { await result.current.marcarLeida('a'); });
    expect(result.current.notificaciones[0].leida).toBe(false);
  });

  it('"marcar todas" = UNA sentencia sobre todas las no leídas del usuario (no solo las visibles)', async () => {
    h.filas = [aviso('a'), aviso('b')];
    const { result } = await montar();
    await act(async () => { await result.current.marcarTodas(); });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].filtros).toEqual(expect.arrayContaining(['usuario_id=user-1', 'leida=false']));
    expect(result.current.noLeidas).toBe(0);
  });

  it('el aviso de "cambia tu contraseña" NO se descarta desde la campana (mantiene el gate encendido)', async () => {
    h.filas = [aviso('pwd', { tipo: 'cambiar_password' }), aviso('b')];
    const { result } = await montar();

    await act(async () => { await result.current.marcarLeida('pwd'); });
    expect(h.updates).toHaveLength(0);

    await act(async () => { await result.current.marcarTodas(); });
    expect(h.updates[0].filtros).toContain('not tipo in (cambiar_password)');
    expect(result.current.notificaciones.find((n) => n.id === 'pwd')?.leida).toBe(false);
  });
});
