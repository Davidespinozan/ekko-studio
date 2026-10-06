import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06E (FR-43/44) · `cron-material-vencido`: marca lo vencido (negocio) y
 * después borra de Storage TODO lo retirado cuyo objeto sigue ahí, con las rutas
 * que da la base. Un fallo deja esos objetos pendientes para la siguiente corrida
 * (la base los vuelve a devolver) y 06G registra el resultado honesto. Storage y la
 * base se simulan; nada real se borra.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  remove: vi.fn(),
  procesos: [] as Array<{ p_estado: string; p_clase_error: string | null }>,
  reportar: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'registrar_ejecucion_proceso') {
        h.procesos.push(args as (typeof h.procesos)[number]);
        return Promise.resolve({ data: {}, error: null });
      }
      return h.rpc(fn, args);
    },
    storage: { from: (bucket: string) => ({ remove: (rutas: string[]) => h.remove(bucket, rutas) }) }
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => h.reportar(...a) }));

import { handler, TANDA } from '../../netlify/functions/cron-material-vencido/index';

type R = { statusCode: number; body: string };
const correr = async () => (await (handler as unknown as (e: unknown, c: unknown) => Promise<R>)({}, {})) as R;
const cuerpo = (r: R) => JSON.parse(r.body) as Record<string, unknown>;

/** Respuestas de las dos RPC: lo recién vencido y la limpieza pendiente. */
function base(vencidos: number, pendientes: string[]) {
  h.rpc.mockImplementation((fn: string) => {
    if (fn === 'material_vencido_por_borrar') return Promise.resolve({ data: Array.from({ length: vencidos }, (_, i) => ({ material_id: `v${i}` })), error: null });
    if (fn === 'material_limpieza_pendiente') return Promise.resolve({ data: pendientes.map((p, i) => ({ material_id: `m${i}`, storage_path: p })), error: null });
    return Promise.resolve({ data: null, error: { message: `rpc inesperado ${fn}` } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.procesos.length = 0;
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  h.remove.mockResolvedValue({ data: [], error: null });
});

describe('cron-material-vencido · PKG-06E', () => {
  it('nada pendiente → éxito sin tocar Storage', async () => {
    base(0, []);
    const r = await correr();
    expect(r.statusCode).toBe(200);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.procesos).toEqual([expect.objectContaining({ p_estado: 'exito' })]);
  });

  it('15/19 · borra lo que la base dice (retirados por staff incluidos), del bucket material, sin duplicar rutas', async () => {
    base(1, ['t/u/r/a.mp4', 't/u/r/b.mp4', 't/u/r/a.mp4']);
    const r = await correr();
    expect(h.remove).toHaveBeenCalledWith('material', ['t/u/r/a.mp4', 't/u/r/b.mp4']);
    expect(cuerpo(r)).toEqual({ vencidos: 1, borrados: 2, pendientes: 0 });
    expect(h.procesos.at(-1)).toMatchObject({ p_estado: 'exito', p_clase_error: null });
  });

  it('26 · por tandas de 100', async () => {
    const rutas = Array.from({ length: TANDA + 30 }, (_, i) => `t/u/r/${i}.mp4`);
    base(0, rutas);
    await correr();
    expect(h.remove).toHaveBeenCalledTimes(2);
    expect((h.remove.mock.calls[0][1] as string[]).length).toBe(TANDA);
    expect((h.remove.mock.calls[1][1] as string[]).length).toBe(30);
  });

  it('16/17/18 · Storage falla en todo → `fallo` almacenamiento; quedan pendientes (la base los devolverá); respuesta sin texto crudo', async () => {
    base(0, ['t/u/r/a.mp4']);
    h.remove.mockResolvedValue({ data: null, error: { message: 'Internal error: s3 bucket ekko-prod unreachable' } });
    const r = await correr();
    expect(r.statusCode).toBe(500);
    expect(cuerpo(r)).toEqual({ error: 'almacenamiento', vencidos: 0, borrados: 0, pendientes: 1 });
    expect(r.body).not.toMatch(/s3|unreachable|bucket/);
    expect(h.procesos.at(-1)).toEqual({ p_proceso: 'cron-material-vencido', p_estado: 'fallo', p_clase_error: 'almacenamiento' });
    expect(h.reportar).toHaveBeenCalledWith('cron-material-vencido', expect.any(Error), expect.objectContaining({ clase: 'storage_remove_failed' }));
  });

  it('18 · una tanda bien y otra mal → `parcial` (06G cuenta el fallo; lo borrado sí se borró)', async () => {
    base(0, Array.from({ length: TANDA + 1 }, (_, i) => `t/u/r/${i}.mp4`));
    h.remove.mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: null, error: { message: 'x' } });
    const r = await correr();
    expect(cuerpo(r)).toMatchObject({ borrados: TANDA, pendientes: 1 });
    expect(h.procesos.at(-1)).toMatchObject({ p_estado: 'parcial', p_clase_error: 'almacenamiento' });
  });

  it('timeout / red (resultado desconocido) → `fallo` almacenamiento, clase storage_result_unknown; la siguiente corrida re-mira', async () => {
    base(0, ['t/u/r/a.mp4']);
    h.remove.mockRejectedValue(new Error('socket hang up'));
    const r = await correr();
    expect(cuerpo(r)).toMatchObject({ error: 'almacenamiento', pendientes: 1 });
    expect(h.reportar).toHaveBeenCalledWith('cron-material-vencido', expect.any(Error), expect.objectContaining({ clase: 'storage_result_unknown' }));
    // 19 · siguiente corrida: Storage ya no lo tiene → la base no lo devuelve → converge.
    base(0, []);
    h.remove.mockReset();
    expect((await correr()).statusCode).toBe(200);
    expect(h.procesos.at(-1)).toMatchObject({ p_estado: 'exito' });
  });

  it('la RPC de vencidos o la de limpieza fallan → `fallo` base_datos, sin borrar nada y sin texto crudo', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'material_vencido_por_borrar' ? { data: null, error: { message: 'relation material_sesion does not exist' } } : { data: [], error: null })
    );
    const r1 = await correr();
    expect(r1.body).not.toMatch(/relation|material_sesion/);
    expect(h.procesos.at(-1)).toMatchObject({ p_estado: 'fallo', p_clase_error: 'base_datos' });
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'material_limpieza_pendiente' ? { data: null, error: { message: 'permission denied for function' } } : { data: [], error: null })
    );
    const r2 = await correr();
    expect(r2.statusCode).toBe(500);
    expect(h.procesos.at(-1)).toMatchObject({ p_estado: 'fallo', p_clase_error: 'base_datos' });
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('43 · las rutas vienen SOLO de la base: rutas vacías o nulas no se mandan a Storage', async () => {
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'material_limpieza_pendiente' ? { data: [{ storage_path: null }, { storage_path: '' }, { storage_path: 't/u/r/ok.mp4' }], error: null } : { data: [], error: null })
    );
    await correr();
    expect(h.remove).toHaveBeenCalledWith('material', ['t/u/r/ok.mp4']);
  });
});
