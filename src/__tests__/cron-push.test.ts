import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * cron-push (PKG-03A): la base reclama las filas con un lease
 * (`reclamar_push_pendientes`) y el resultado se asienta DESPUÉS de intentar
 * (`registrar_resultado_push`). Antes se marcaba `push_enviado_at` en un `finally`
 * aunque el envío fallara. El lease y "solo filas sin resultado" se prueban contra
 * Postgres real en src/__tests__/db/03a-pendientes-operativos.db.test.ts.
 */

const h = vi.hoisted(() => ({
  pendientes: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  enviar: vi.fn(),
  reportar: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (fn: string, args: unknown) => {
      h.rpc(fn, args);
      if (fn === 'reclamar_push_pendientes') return Promise.resolve({ data: h.pendientes, error: null });
      return Promise.resolve({ data: 1, error: null });
    },
    from: () => { throw new Error('cron-push no debe escribir notificaciones directo'); }
  }))
}));
vi.mock('../../netlify/functions/_lib/push', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/push')>()),
  enviarPushAUsuario: (...a: unknown[]) => h.enviar(...a)
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => h.reportar(...a) }));

import { handler } from '../../netlify/functions/cron-push/index';

const correr = async () => JSON.parse(((await handler({} as never, {} as never)) as { body: string }).body);
const asientos = () => h.rpc.mock.calls.filter((c) => c[0] === 'registrar_resultado_push').map((c) => c[1]);
const fila = (id: string) => ({ id, usuario_id: `u-${id}`, tipo: 'reserva_cancelada', titulo: 't', mensaje: 'm', metadata: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.pendientes = [];
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
});

describe('cron-push', () => {
  it('reclama en la base (lote de 200) y asienta un resultado por fila después de intentar', async () => {
    h.pendientes = [fila('a'), fila('b'), fila('c'), fila('d')];
    h.enviar
      .mockResolvedValueOnce({ enviados: 1, borrados: 0, fallidos: 0 })
      .mockResolvedValueOnce({ enviados: 0, borrados: 0 })
      .mockResolvedValueOnce({ enviados: 0, borrados: 0, fallidos: 1 })
      .mockResolvedValueOnce({ enviados: 0, borrados: 0, sinConfig: true });
    const r = await correr();
    expect(h.rpc).toHaveBeenCalledWith('reclamar_push_pendientes', { p_limite: 200 });
    expect(asientos()).toEqual([
      { p_ids: ['a'], p_resultado: 'enviado' },
      { p_ids: ['b'], p_resultado: 'sin_suscripcion' },
      { p_ids: ['c'], p_resultado: 'fallo' },
      { p_ids: ['d'], p_resultado: 'sin_config' }
    ]);
    expect(r).toEqual({ pendientes: 4, pushEnviados: 1 });
  });

  it('una excepción al enviar queda como fallo (nunca como enviado) y se reporta', async () => {
    h.pendientes = [fila('a')];
    h.enviar.mockRejectedValue(new Error('web-push caído'));
    await correr();
    expect(asientos()).toEqual([{ p_ids: ['a'], p_resultado: 'fallo' }]);
    expect(h.reportar).toHaveBeenCalledWith('cron-push', expect.any(Error), expect.objectContaining({ notificacion_id: 'a' }));
  });

  it('sin pendientes no asienta nada', async () => {
    const r = await correr();
    expect(asientos()).toEqual([]);
    expect(r).toEqual({ pendientes: 0, pushEnviados: 0 });
  });
});
