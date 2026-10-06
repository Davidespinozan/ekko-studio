// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-03B · migración 20261011100000 contra Postgres real (PGlite).
 * Persistencia de discrepancias: una abierta por identidad, cierre solo con
 * corrida completa, episodios nuevos al reaparecer, revisar ≠ cerrar, y su
 * lectura en v_pendientes_operativos (admin de su estudio).
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let m: Persona;
let adminB: Persona;
let tenantB: string;

const comoAnon = async <T,>(fn: () => Promise<T>): Promise<T> => {
  await b.db.exec(`SELECT set_config('request.jwt.claim.role', 'anon', false); SET ROLE anon;`);
  try { return await fn(); } finally { await b.db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false);`); }
};
const d = (sub: string, tipo: string, resumen = 'x') => ({ stripe_subscription_id: sub, tipo, membresia_id: null, usuario_id: null,
  esperado: { resumen: `EKKO ${resumen}` }, observado: { resumen: `Stripe ${resumen}` } });
const registrar = (tenant: string, estado: string, lista: unknown[], corrida = randomUUID(), error: string | null = null) =>
  b.fila<{ r: Record<string, unknown> }>('SELECT registrar_reconciliacion_stripe($1, $2, $3, $4, $5, $6) AS r',
    [corrida, tenant, estado, lista.length, JSON.stringify(lista), error]).then((x) => x.r);
const abiertas = (tenant: string) => b.filas<{ id: string; stripe_subscription_id: string; tipo: string; veces: number; revisada_at: string | null }>(
  `SELECT id, stripe_subscription_id, tipo, veces, revisada_at FROM discrepancias_stripe WHERE tenant_id = $1 AND estado = 'abierta' ORDER BY stripe_subscription_id, tipo`, [tenant]);
const todas = (tenant: string, sub: string) => b.filas<{ estado: string; resolucion: string | null }>(
  `SELECT estado, resolucion FROM discrepancias_stripe WHERE tenant_id = $1 AND stripe_subscription_id = $2 ORDER BY detectada_at`, [tenant, sub]);
const vista = (p: Persona) => b.como(p, () => b.filas<{ tipo: string; fuente: string; fuente_id: string; tenant_id: string; severidad: string; accion: string; detalle: string | null }>(
  `SELECT tipo, fuente, fuente_id, tenant_id, severidad, accion, detalle FROM v_pendientes_operativos WHERE fuente IN ('discrepancias_stripe', 'reconciliacion_stripe_corridas')`));

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  m = await b.crearPersona();
  tenantB = (await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-03b', 'Otro', 'activo') RETURNING id`)).id;
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-b-03b@test.mx', '{"tenant_slug":"b-03b"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'admin', status = 'activo', identidad_completa = true, contrato_firmado = true WHERE auth_id = $1 RETURNING id`, [a.id]);
  adminB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('discrepancias_stripe: ciclo de vida', () => {
  it('9 · corridas repetidas actualizan la MISMA abierta (sin duplicar)', async () => {
    await registrar(b.tenantId, 'completa', [d('sub_9', 'pausa_distinta')]);
    await registrar(b.tenantId, 'completa', [d('sub_9', 'pausa_distinta', 'otra vez')]);
    const a = (await abiertas(b.tenantId)).filter((x) => x.stripe_subscription_id === 'sub_9');
    expect(a).toHaveLength(1);
    expect(a[0].veces).toBe(2);
    await expect(b.db.query(`INSERT INTO discrepancias_stripe (tenant_id, stripe_subscription_id, tipo) VALUES ($1, 'sub_9', 'pausa_distinta')`, [b.tenantId]))
      .rejects.toThrow(/discrepancias_stripe_abierta_uniq/);
  });

  it('10 · una corrida COMPLETA que ya no la ve la cierra como convergida', async () => {
    await registrar(b.tenantId, 'completa', [d('sub_10', 'plan_distinto'), d('sub_9', 'pausa_distinta')]);
    const r = await registrar(b.tenantId, 'completa', [d('sub_9', 'pausa_distinta')]);
    expect(r).toMatchObject({ cerradas: 1 });
    expect(await todas(b.tenantId, 'sub_10')).toEqual([{ estado: 'resuelta', resolucion: 'convergio' }]);
  });

  it('11 · reaparecer tras cerrar abre un EPISODIO nuevo (la historia no se reescribe)', async () => {
    await registrar(b.tenantId, 'completa', [d('sub_10', 'plan_distinto'), d('sub_9', 'pausa_distinta')]);
    expect(await todas(b.tenantId, 'sub_10')).toEqual([
      { estado: 'resuelta', resolucion: 'convergio' }, { estado: 'abierta', resolucion: null }
    ]);
  });

  it('12 · una corrida PARCIAL o FALLIDA nunca cierra; fallida no admite observaciones; corrida repetida es idempotente', async () => {
    const antes = (await abiertas(b.tenantId)).length;
    await registrar(b.tenantId, 'parcial', [], randomUUID(), 'stripe:StripeRateLimitError:429');
    await registrar(b.tenantId, 'fallida', [], randomUUID(), 'stripe:boom');
    expect((await abiertas(b.tenantId)).length).toBe(antes);
    await expect(registrar(b.tenantId, 'fallida', [d('sub_x', 'plan_distinto')])).rejects.toThrow(/EKKO_CORRIDA_FALLIDA_CON_DATOS/);
    const c = randomUUID();
    await registrar(b.tenantId, 'completa', [d('sub_9', 'pausa_distinta')], c);
    expect(await registrar(b.tenantId, 'completa', [], c)).toEqual({ idempotente: true });
  });

  it('el estudio B no cierra ni toca lo del estudio A', async () => {
    const a = (await abiertas(b.tenantId)).length;
    await registrar(tenantB, 'completa', [d('sub_b', 'suscripcion_huerfana')]);
    expect((await abiertas(b.tenantId)).length).toBe(a);
    expect((await abiertas(tenantB)).map((x) => x.stripe_subscription_id)).toEqual(['sub_b']);
  });

  it('revisar (admin, con nota) NO cierra: sigue abierta y visible hasta converger', async () => {
    const [x] = (await abiertas(b.tenantId)).filter((y) => y.stripe_subscription_id === 'sub_9');
    const revisar = (p: Persona, id: string) => b.como(p, () => b.fila<{ r: Record<string, unknown> }>(
      `SELECT revisar_discrepancia_stripe($1, 'Revisado en el panel de Stripe') AS r`, [id])).then((y) => y.r);
    await expect(revisar(recep, x.id)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(revisar(adminB, x.id)).rejects.toThrow(/EKKO_DISCREPANCIA_INVALIDA/);
    expect(await revisar(admin, x.id)).toMatchObject({ idempotente: false });
    expect(await revisar(admin, x.id)).toMatchObject({ idempotente: true });
    const fila = (await abiertas(b.tenantId)).find((y) => y.id === x.id)!;
    expect(fila.revisada_at).not.toBeNull();
    const v = (await vista(admin)).find((y) => y.fuente_id === x.id)!;
    expect(v).toMatchObject({ accion: 'discrepancia_revisada', severidad: 'baja' });
  });
});

describe('v_pendientes_operativos (03A + 03B)', () => {
  it('19 · el admin ve las discrepancias abiertas de SU estudio con contexto, y la última corrida si no fue completa', async () => {
    await registrar(b.tenantId, 'parcial', [d('sub_9', 'pausa_distinta')], randomUUID(), 'limite_paginas');
    const v = await vista(admin);
    expect(v.every((x) => x.tenant_id === b.tenantId)).toBe(true);
    const dis = v.find((x) => x.tipo === 'discrepancia_pausa_distinta')!;
    expect(dis.detalle).toContain('sub_9');
    expect(dis.detalle).toContain('EKKO ');
    expect(dis.detalle).toContain('Stripe ');
    expect(v.some((x) => x.tipo === 'reconciliacion_parcial' && x.accion === 'reconciliacion_incompleta')).toBe(true);
    expect(v.some((x) => x.fuente_id.includes('sub_b'))).toBe(false);
    // Una corrida completa posterior saca el aviso de "incompleta".
    await registrar(b.tenantId, 'completa', [d('sub_9', 'pausa_distinta')]);
    expect((await vista(admin)).some((x) => x.fuente === 'reconciliacion_stripe_corridas')).toBe(false);
  });

  it('20 · recepción, miembro y anon no la leen; tampoco las tablas', async () => {
    expect(await vista(recep)).toEqual([]);
    expect(await vista(m)).toEqual([]);
    expect(await b.como(recep, () => b.filas('SELECT 1 FROM discrepancias_stripe'))).toEqual([]);
    expect(await b.como(m, () => b.filas('SELECT 1 FROM reconciliacion_stripe_corridas'))).toEqual([]);
    await expect(comoAnon(() => b.filas('SELECT 1 FROM discrepancias_stripe'))).rejects.toThrow(/permission denied/);
    await expect(comoAnon(() => b.filas('SELECT 1 FROM v_pendientes_operativos'))).rejects.toThrow(/permission denied/);
  });

  it('nadie escribe por REST; el registro es solo de service_role; las funciones no son de anon/PUBLIC', async () => {
    await expect(b.como(admin, () => b.fila(`UPDATE discrepancias_stripe SET estado = 'resuelta'`))).rejects.toThrow(/permission denied/);
    await expect(b.como(admin, () => b.fila(`SELECT registrar_reconciliacion_stripe(gen_random_uuid(), $1, 'completa', 0, '[]'::jsonb, NULL)`, [b.tenantId])))
      .rejects.toThrow(/permission denied/);
    const r = await b.filas<{ f: string; anon: boolean; publico: boolean; auth: boolean }>(
      `SELECT p.proname AS f, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS publico,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
       FROM pg_proc p WHERE p.proname IN ('registrar_reconciliacion_stripe', 'revisar_discrepancia_stripe') ORDER BY 1`);
    expect(r).toEqual([
      { f: 'registrar_reconciliacion_stripe', anon: false, publico: false, auth: false },
      { f: 'revisar_discrepancia_stripe', anon: false, publico: false, auth: true }
    ]);
  });
});
