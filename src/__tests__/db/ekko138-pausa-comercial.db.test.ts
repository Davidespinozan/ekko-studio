// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * EKKO-138 · D-03A-1 = A · migración 20261010100000 contra Postgres real (PGlite).
 *
 * `membresias.pausa_comercial_at` es la INTENCIÓN de pausa del staff, separada de
 * la sanción y del eco del proveedor (`status = 'pausada'` que llega por webhook):
 *  · levantar la sanción con la intención vigente NO reanuda el cobro;
 *  · reactivar durante una sanción quita la intención pero NO reanuda el cobro;
 *  · el webhook nunca crea ni borra la intención;
 *  · la revocación sigue siendo terminal.
 */

let b: BaseDePrueba;
let recep: Persona;
let admin: Persona;
let recepB: Persona;
let n = 0;

type Op = { tipo: string; estado: string; motivo_descarte: string | null; operation_key: string; causa: string };

const conSub = async () => {
  const m = await b.crearPersona();
  const sub = `sub_138_${++n}`;
  await b.activar(m, 'esencial', { id: sub, fin: '2099-01-01' });
  return { m, sub };
};
const mem = (m: Persona) => b.fila<{ status: string; intencion: boolean; pausa_comercial_at: string | null }>(
  `SELECT status, pausa_comercial_at IS NOT NULL AS intencion, pausa_comercial_at FROM membresias
   WHERE usuario_id = $1 ORDER BY created_at DESC LIMIT 1`, [m.id]);
const cuenta = (m: Persona) => b.fila<{ status: string }>('SELECT status FROM usuarios WHERE id = $1', [m.id]).then((x) => x.status);
const ops = (m: Persona) => b.filas<Op>(
  `SELECT tipo, estado, motivo_descarte, operation_key, causa FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 ORDER BY created_at`, [m.id]);
const pausar = (m: Persona, p: boolean, quien: Persona = recep) =>
  b.como(quien, () => b.fila<{ r: Record<string, unknown> }>('SELECT staff_pausar_membresia($1, $2, $3) AS r', [m.id, p, 'Viaje largo'])).then((x) => x.r);
const sancionar = (m: Persona) => b.db.query(`UPDATE usuarios SET sancionado_at = now(), sancion_motivo = 'Daños al equipo' WHERE id = $1`, [m.id]);
const levantar = (m: Persona) => b.db.query(`UPDATE usuarios SET sancionado_at = NULL, sancion_motivo = NULL, status = 'activo' WHERE id = $1`, [m.id]);
/** El ejecutor (Stripe simulado OK): prepara y asienta lo pendiente del miembro. */
const aplicar = async (m: Persona) => {
  const pend = await b.filas<{ id: string }>(`SELECT id FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 AND estado IN ('pendiente', 'fallida') ORDER BY created_at`, [m.id]);
  for (const o of pend) {
    const p = await b.fila<{ p: { ejecutar: boolean } }>('SELECT operacion_suscripcion_preparar($1) AS p', [o.id]);
    if (p.p.ejecutar) await b.fila(`SELECT operacion_suscripcion_resultado($1, true, NULL, '{}'::jsonb)`, [o.id]);
  }
};
/** Eco del proveedor (webhook customer.subscription.updated). */
const eco = (sub: string, estado: 'pausada' | 'activa') =>
  b.fila(`SELECT sync_membresia_stripe($1, $2, '2099-02-01', NULL, now())`, [sub, estado]);

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
  admin = await b.crearPersona({ rol: 'admin' });
  await b.db.query(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-138', 'Otro', 'activo')`);
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('recep-b-138@test.mx', '{"tenant_slug":"b-138"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'recepcionista', status = 'activo', identidad_completa = true, contrato_firmado = true WHERE auth_id = $1 RETURNING id`, [a.id]);
  recepB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('pausa comercial del staff', () => {
  it('1-2 · activa → pausa del staff (intención durable) → reactivación (la quita); auditado con contexto', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: true });
    expect(await cuenta(m)).toBe('suspendido');
    await pausar(m, false);
    expect(await mem(m)).toMatchObject({ status: 'activa', intencion: false });
    expect(await cuenta(m)).toBe('activo');
    const audit = await b.filas<{ accion: string; m: Record<string, unknown> }>(
      `SELECT accion, metadata AS m FROM audit_log WHERE target_id = $1 AND accion IN ('membresia_pausada', 'membresia_reactivada') ORDER BY creada_at`, [m.id]);
    expect(audit.map((x) => x.accion)).toEqual(['membresia_pausada', 'membresia_reactivada']);
    expect(audit[0].m).toMatchObject({ pausa_comercial: true, solo_intencion: false, sancionado: false });
  });

  it('13-14 · pausar dos veces y reactivar dos veces es idempotente (sin auditoría ni aviso repetidos)', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    expect(await pausar(m, true)).toMatchObject({ success: true, idempotente: true });
    await pausar(m, false);
    expect(await pausar(m, false)).toMatchObject({ success: true, idempotente: true });
    const audit = await b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1 AND accion IN ('membresia_pausada', 'membresia_reactivada')`, [m.id]);
    expect(audit.n).toBe(2);
    expect(await mem(m)).toMatchObject({ status: 'activa', intencion: false });
  });
});

describe('sanción y pausa comercial', () => {
  it('3 · sin pausa comercial: sanción suspende el cobro; levantarla lo reanuda (comportamiento R2-B intacto)', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    // 9 · el eco de la suspensión por sanción NO es intención del staff.
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: false });
    await levantar(m);
    expect((await ops(m)).map((o) => [o.tipo, o.estado])).toEqual([['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'pendiente']]);
  });

  it('4 · pausa del staff → sanción → levantar: nunca hubo suspensión por sanción; nada que reanudar; la pausa sigue', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await sancionar(m);
    expect(await ops(m)).toEqual([]);
    await levantar(m);
    expect(await ops(m)).toEqual([]);
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: true });
  });

  it('5 · sanción (cobro suspendido) → el staff pausa → levantar: NO reanuda; queda escrito por qué (D-03A-1 = A)', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    // La membresía ya está en pausa por el proveedor: el staff declara SOLO la intención.
    expect(await pausar(m, true)).toMatchObject({ success: true, status: 'pausada' });
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: true });
    await levantar(m);
    const o = await ops(m);
    expect(o.map((x) => [x.tipo, x.estado, x.motivo_descarte])).toEqual([
      ['suspender_cobro', 'aplicada', null],
      ['reanudar_cobro', 'descartada', 'pausa_comercial_vigente']
    ]);
    // 16 · la llave de la reanudación es la de esa suspensión (una por ciclo).
    const susp = await b.fila<{ id: string }>(`SELECT id FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 AND tipo = 'suspender_cobro'`, [m.id]);
    expect(o[1].operation_key).toBe(`reanudar:${susp.id}`);
    // 15 · levantar otra vez / re-evaluar no duplica nada.
    await levantar(m);
    await b.fila('SELECT _reconciliar_cobro_sancion($1)', [m.id]);
    expect(await ops(m)).toHaveLength(2);

    // El cobro vuelve SOLO con la reactivación explícita del staff…
    await pausar(m, false);
    expect(await mem(m)).toMatchObject({ status: 'activa', intencion: false });
    // …y si hay una NUEVA sanción, se vuelve a suspender (el ciclo anterior quedó cerrado).
    await sancionar(m);
    expect((await ops(m)).filter((x) => x.tipo === 'suspender_cobro').map((x) => x.estado)).toEqual(['aplicada', 'pendiente']);
  });

  it('5b · el staff pausa ANTES de que llegue el eco de la sanción: misma regla (no reanuda al levantar)', async () => {
    const { m } = await conSub();
    await sancionar(m);
    await pausar(m, true); // aún 'activa' → pausa normal con intención
    await aplicar(m);
    await levantar(m);
    expect((await ops(m)).map((x) => [x.tipo, x.estado, x.motivo_descarte])).toEqual([
      ['suspender_cobro', 'aplicada', null],
      ['reanudar_cobro', 'descartada', 'pausa_comercial_vigente']
    ]);
  });

  it('6 · sanción → reactivar: la membresía vuelve pero el cobro sigue suspendido por la sanción; se reanuda al levantarla', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    expect(await pausar(m, false)).toMatchObject({ success: true, status: 'activa', cobro_suspendido_por_sancion: true });
    expect(await cuenta(m)).toBe('suspendido'); // la sanción manda el acceso
    // Ninguna reanudación mientras siga sancionado.
    expect((await ops(m)).map((x) => [x.tipo, x.estado])).toEqual([['suspender_cobro', 'aplicada']]);
    await levantar(m);
    expect((await ops(m)).map((x) => [x.tipo, x.estado])).toEqual([['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'pendiente']]);
  });

  it('6b · pausa del staff → sanción → reactivar: se crea la suspensión de la sanción (reactivar no la salta)', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await sancionar(m);
    expect(await ops(m)).toEqual([]);
    await pausar(m, false);
    expect((await ops(m)).map((x) => [x.tipo, x.causa, x.estado])).toEqual([['suspender_cobro', 'sancion', 'pendiente']]);
    await aplicar(m);
    await levantar(m);
    expect((await ops(m)).map((x) => [x.tipo, x.estado])).toEqual([['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'pendiente']]);
  });

  it('17 · una reanudación en espera se descarta si el staff pausa antes de ejecutarla; un fallo del proveedor no toca la intención', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    await levantar(m); // reanudar pendiente
    await pausar(m, true);
    await aplicar(m);
    const r = (await ops(m)).find((x) => x.tipo === 'reanudar_cobro')!;
    expect([r.estado, r.motivo_descarte]).toEqual(['descartada', 'pausa_comercial_vigente']);
    expect(await mem(m)).toMatchObject({ intencion: true });

    const otro = await conSub();
    await sancionar(otro.m);
    const s = await b.fila<{ id: string }>(`SELECT id FROM stripe_operaciones_suscripcion WHERE usuario_id = $1`, [otro.m.id]);
    await b.fila('SELECT operacion_suscripcion_preparar($1)', [s.id]);
    await b.fila(`SELECT operacion_suscripcion_resultado($1, false, 'Stripe caído', NULL)`, [s.id]);
    expect((await ops(otro.m))[0].estado).toBe('fallida');
    expect(await mem(otro.m)).toMatchObject({ intencion: false });
  });
});

describe('webhook: hechos del proveedor, nunca intención', () => {
  it('7-8, 10 · con pausa del staff, el eco pausada o activa NO crea ni borra la intención', async () => {
    const { m, sub } = await conSub();
    await pausar(m, true);
    await eco(sub, 'pausada');
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: true });
    await eco(sub, 'activa'); // alguien reanudó en el panel de Stripe: es un hecho del proveedor
    expect(await mem(m)).toMatchObject({ status: 'activa', intencion: true });
  });

  it('9 · el eco de pausa sin staff nunca se vuelve intención', async () => {
    const { m, sub } = await conSub();
    await eco(sub, 'pausada');
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: false });
  });
});

describe('terminal y fronteras', () => {
  it('11 · cuenta revocada: pausar/reactivar no la resucitan (contrato R1) y nada reanuda el cobro', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    await pausar(m, true);
    await pausar(m, false);
    await levantar(m);
    expect(await cuenta(m)).toBe('revocado');
    expect((await ops(m)).some((o) => o.tipo === 'reanudar_cobro' && o.estado !== 'descartada')).toBe(false);
    expect((await ops(m)).some((o) => o.tipo === 'cancelar_suscripcion')).toBe(true);
  });

  it('12 · membresía terminada: no se reactiva; una reanudación pendiente sobre ella se descarta', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    await levantar(m); // reanudar pendiente
    await eco(sub, 'activa');
    await b.fila(`SELECT sync_membresia_stripe($1, 'cancelada', NULL, NULL, now())`, [sub]);
    await aplicar(m);
    const r = (await ops(m)).find((x) => x.tipo === 'reanudar_cobro')!;
    // Descartada por R2-B (el trigger de cancelación o la revalidación del ejecutor): nunca se reanuda.
    expect(r.estado).toBe('descartada');
    expect(['membresia_cancelada', 'membresia_no_vigente']).toContain(r.motivo_descarte);
    await expect(pausar(m, false)).rejects.toThrow(/EKKO_SIN_PAUSA/);
  });

  it('18 · aislamiento: recepción de otro estudio no pausa ni reactiva a este miembro', async () => {
    const { m } = await conSub();
    await expect(pausar(m, true, recepB)).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
    expect(await mem(m)).toMatchObject({ intencion: false });
  });

  it('19 · nadie escribe la intención por REST (ni admin): solo la transición del servidor', async () => {
    const { m } = await conSub();
    for (const p of [m, recep, admin]) {
      await expect(b.como(p, () => b.fila(`UPDATE membresias SET pausa_comercial_at = now() WHERE usuario_id = $1`, [m.id]))).rejects.toThrow(/permission denied/);
    }
    const pub = await b.fila<{ anon: boolean; publico: boolean }>(
      `SELECT has_function_privilege('anon', 'staff_pausar_membresia(uuid, boolean, text)', 'EXECUTE') AS anon,
              EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = 'staff_pausar_membresia(uuid, boolean, text)'::regprocedure)) a WHERE a.grantee = 0) AS publico`);
    expect(pub).toEqual({ anon: false, publico: false });
    await expect(b.como(m, () => b.fila(`SELECT staff_pausar_membresia($1, true, 'yo mismo')`, [m.id]))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });
});
