// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * F-1 · migración 20261008100000 contra Postgres real (PGlite).
 *
 * `valor_por_lote` y `movimientos_sin_vinculo` agregan el ledger de valor. Antes
 * se evaluaban con los permisos del dueño (salta RLS) y `anon` podía leerlas:
 * cualquiera con la llave pública veía el valor de todos los estudios. Ahora son
 * `security_invoker`: manda la RLS de `membresia_movimientos`.
 */

const VISTAS = ['valor_por_lote', 'movimientos_sin_vinculo'] as const;

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let m: Persona;
let otro: Persona;
let membresiaA: string;
let membresiaB: string;

const comoAnon = async <T,>(fn: () => Promise<T>): Promise<T> => {
  await b.db.exec(`SELECT set_config('request.jwt.claim.role', 'anon', false); SET ROLE anon;`);
  try { return await fn(); } finally { await b.db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false);`); }
};
const membresias = (filas: Array<{ membresia_id: string }>) => [...new Set(filas.map((f) => f.membresia_id))].sort();

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  m = await b.crearPersona();
  otro = await b.crearPersona();
  // Tenant A: una suscripción de Stripe sin vincular (cae en las dos vistas).
  membresiaA = ((await b.activar(m, 'esencial', { id: 'sub_f1_a' })) as { membresia_id: string }).membresia_id;
  await b.activar(otro, 'esencial', { id: 'sub_f1_otro' });

  // Tenant B, solo con SQL de superusuario (como service_role): misma forma de datos.
  const t = await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('f1-otro', 'Otro', 'activo') RETURNING id`);
  const tier = await b.fila<{ id: string }>(
    `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos) VALUES ($1, 'f1-plan', 'Plan', 100) RETURNING id`, [t.id]);
  const u = await b.fila<{ id: string }>(
    `INSERT INTO usuarios (tenant_id, email, rol, status) VALUES ($1, 'f1-b@test.mx', 'miembro', 'activo') RETURNING id`, [t.id]);
  membresiaB = (await b.fila<{ id: string }>(
    `INSERT INTO membresias (tenant_id, usuario_id, tier_id, status) VALUES ($1, $2, $3, 'activa') RETURNING id`, [t.id, u.id, tier.id])).id;
  await b.fila(
    `INSERT INTO membresia_movimientos (tenant_id, membresia_id, usuario_id, tipo, delta, origen)
     VALUES ($1, $2, $3, 'alta', 4, 'suscripcion_stripe')`, [t.id, membresiaB, u.id]);
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('F-1 · vistas de valor aisladas', () => {
  it('el superusuario (service_role) ve ambos tenants: la definición no cambió', async () => {
    for (const v of VISTAS) {
      const todas = membresias(await b.filas<{ membresia_id: string }>(`SELECT membresia_id FROM ${v}`));
      expect(todas, v).toEqual(expect.arrayContaining([membresiaA, membresiaB]));
    }
  });

  it('anon no puede leer ninguna de las dos (permission denied)', async () => {
    for (const v of VISTAS) {
      await expect(comoAnon(() => b.filas(`SELECT * FROM ${v}`)), v).rejects.toThrow(/permission denied/);
    }
  });

  it('el admin del tenant A ve lo de A y nada del tenant B', async () => {
    for (const v of VISTAS) {
      const vistas = membresias(await b.como(admin, () => b.filas<{ membresia_id: string }>(`SELECT membresia_id FROM ${v}`)));
      expect(vistas, v).toContain(membresiaA);
      expect(vistas, v).not.toContain(membresiaB);
    }
  });

  it('un miembro solo ve su propio valor; recepción (sin policy en el ledger) no ve nada', async () => {
    for (const v of VISTAS) {
      expect(membresias(await b.como(m, () => b.filas<{ membresia_id: string }>(`SELECT membresia_id FROM ${v}`))), v).toEqual([membresiaA]);
      expect(await b.como(recep, () => b.filas(`SELECT 1 FROM ${v}`)), v).toEqual([]);
    }
  });

  it('privilegios: security_invoker; anon/PUBLIC sin nada; authenticated solo SELECT; service_role intacto', async () => {
    for (const v of VISTAS) {
      const r = await b.fila<{ inv: boolean; anon: boolean; auth_sel: boolean; auth_otro: boolean; svc: boolean; publico: boolean }>(
        `SELECT coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'), 'false')::boolean AS inv,
                has_table_privilege('anon', c.oid, 'SELECT') AS anon,
                has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_sel,
                has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE')
                  OR has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_otro,
                has_table_privilege('service_role', c.oid, 'SELECT') AS svc,
                EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0) AS publico
         FROM pg_class c WHERE c.oid = $1::regclass`, [`public.${v}`]);
      expect(r, v).toEqual({ inv: true, anon: false, auth_sel: true, auth_otro: false, svc: true, publico: false });
    }
  });
});
