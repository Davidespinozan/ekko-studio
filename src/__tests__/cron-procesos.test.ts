import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06G · Cada cron que importa asienta el resultado de SU corrida en
 * `procesos_programados` (vía `registrar_ejecucion_proceso`) al TERMINAR, con una
 * clase de error fija y sin texto crudo. Si no puede asentar, no rompe el cron:
 * el atraso lo delata después (lo prueba db/06g-senales-operativas).
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  respuestas: {} as Record<string, { data?: unknown; error?: { message: string } | null } | (() => never)>,
  remove: vi.fn(),
  ejecutar: vi.fn(),
  procesos: [] as Array<{ p_proceso: string; p_estado: string; p_clase_error: string | null }>
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.rpc(fn, args);
      if (fn === 'registrar_ejecucion_proceso') {
        h.procesos.push(args as (typeof h.procesos)[number]);
        return Promise.resolve({ data: {}, error: null });
      }
      const r = h.respuestas[fn];
      if (typeof r === 'function') return r();
      return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
    },
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'lt', 'gte', 'not', 'is', 'limit']) c[m] = () => c;
      c.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(cb);
      return c;
    },
    storage: { from: () => ({ remove: (...a: unknown[]) => h.remove(...a) }) }
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({
  reportarErrorServidor: vi.fn().mockResolvedValue(undefined),
  conMonitorCron: (_slug: string, _expr: string, fn: unknown) => fn
}));
vi.mock('../../netlify/functions/_lib/operacionesSuscripcion', () => ({
  ejecutarOperacionesSuscripcion: (...a: unknown[]) => h.ejecutar(...a)
}));

import { handler as noShows } from '../../netlify/functions/cron-no-shows/index';
import { handler as recordatorios } from '../../netlify/functions/cron-recordatorios/index';
import { handler as material } from '../../netlify/functions/cron-material-vencido/index';
import { handler as expirar } from '../../netlify/functions/cron-expirar-membresias/index';
import { handler as felicitaciones } from '../../netlify/functions/cron-felicitaciones/index';

type H = (e: never, c: never) => Promise<unknown>;
const correr = async (fn: unknown) => (await (fn as H)({} as never, {} as never)) as { statusCode: number; body: string };

beforeEach(() => {
  vi.clearAllMocks();
  h.procesos.length = 0;
  h.respuestas = {};
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  delete process.env.STRIPE_SECRET_KEY;
  h.remove.mockResolvedValue({ error: null });
  h.ejecutar.mockResolvedValue({ procesadas: 0, aplicadas: 0, fallidas: 0, descartadas: 0, sin_stripe: true });
});

describe('PKG-06G · registro de corridas', () => {
  it('4 · cron-no-shows: `exito` solo DESPUÉS de que la RPC terminó; es la última llamada', async () => {
    h.respuestas.marcar_no_shows = { data: { marcadas: 2 } };
    expect((await correr(noShows)).statusCode).toBe(200);
    expect(h.procesos).toEqual([{ p_proceso: 'cron-no-shows', p_estado: 'exito', p_clase_error: null }]);
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(['marcar_no_shows', 'registrar_ejecucion_proceso']);
  });

  it('5/8 · falla la RPC → `fallo` clase base_datos, sin texto crudo en lo asentado', async () => {
    h.respuestas.marcar_no_shows = { error: { message: 'relation "reservas" does not exist' } };
    expect((await correr(noShows)).statusCode).toBe(500);
    expect(h.procesos).toEqual([{ p_proceso: 'cron-no-shows', p_estado: 'fallo', p_clase_error: 'base_datos' }]);
    expect(JSON.stringify(h.procesos)).not.toMatch(/relation|reservas/);
  });

  it('excepción inesperada → `fallo` clase interno', async () => {
    h.respuestas.generar_recordatorios_reservas = () => { throw new Error('boom'); };
    await correr(recordatorios);
    expect(h.procesos).toEqual([{ p_proceso: 'cron-recordatorios', p_estado: 'fallo', p_clase_error: 'interno' }]);
  });

  it('sin variables de entorno no hay cliente: no se asienta nada (el atraso lo delatará), y el cron no revienta', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await correr(noShows)).statusCode).toBe(500);
    expect(h.procesos).toEqual([]);
  });

  it('cron-material-vencido: sin nada que borrar = `exito`; Storage falla = `fallo` almacenamiento', async () => {
    h.respuestas.material_vencido_por_borrar = { data: [] };
    await correr(material);
    expect(h.procesos.at(-1)).toEqual({ p_proceso: 'cron-material-vencido', p_estado: 'exito', p_clase_error: null });
    // PKG-06E: las rutas a borrar salen de `material_limpieza_pendiente` (lo retirado
    // cuyo objeto sigue en Storage), no solo de lo recién vencido.
    h.respuestas.material_vencido_por_borrar = { data: [{ storage_path: 't/a.mp4' }] };
    h.respuestas.material_limpieza_pendiente = { data: [{ storage_path: 't/a.mp4' }] };
    h.remove.mockResolvedValue({ error: { message: 'bucket not found' } });
    await correr(material);
    expect(h.procesos.at(-1)).toEqual({ p_proceso: 'cron-material-vencido', p_estado: 'fallo', p_clase_error: 'almacenamiento' });
  });

  it('cron-expirar-membresias: todo bien = `exito`; un paso secundario (cobros) revienta = `parcial` (las expiraciones sí se aplicaron)', async () => {
    h.respuestas.expirar_membresias_vencidas = { data: 1 };
    await correr(expirar);
    expect(h.procesos.at(-1)).toEqual({ p_proceso: 'cron-expirar-membresias', p_estado: 'exito', p_clase_error: null });
    h.ejecutar.mockRejectedValue(new Error('stripe caído'));
    const r = await correr(expirar);
    expect(r.statusCode).toBe(200);
    expect(h.procesos.at(-1)).toEqual({ p_proceso: 'cron-expirar-membresias', p_estado: 'parcial', p_clase_error: 'interno' });
  });

  it('cron-expirar-membresias: la RPC principal falla = `fallo` base_datos', async () => {
    h.respuestas.expirar_membresias_vencidas = { error: { message: 'deadlock' } };
    await correr(expirar);
    expect(h.procesos).toEqual([{ p_proceso: 'cron-expirar-membresias', p_estado: 'fallo', p_clase_error: 'base_datos' }]);
  });

  it('1 · los de cortesía (felicitaciones) no se instrumentan: no asientan nada', async () => {
    h.respuestas.generar_felicitaciones_cumpleanos = { data: [] };
    await correr(felicitaciones);
    expect(h.procesos).toEqual([]);
  });
});
