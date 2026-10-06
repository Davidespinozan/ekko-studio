// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-06B · migración 20261016100000 contra Postgres real (PGlite).
 *
 * Lo que el MIEMBRO pide (cambio de plan, baja/reactivación al fin del periodo) y
 * lo que el WEBHOOK debe deshacer (la suscripción anterior tras activar otra)
 * queda como operación durable en `stripe_operaciones_suscripcion`, con identidad
 * estable, resultado honesto y visible en Operación. Stripe aquí es
 * `preparar` + `resultado` (lo que hace el ejecutor alrededor de la llamada).
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let n = 0;

type Op = { id: string; tipo: string; causa: string; estado: string; motivo_descarte: string | null; operation_key: string; ultimo_error: string | null; contexto: Record<string, unknown> };
const ops = (p: Persona) => b.filas<Op>(
  `SELECT id, tipo, causa, estado, motivo_descarte, operation_key, ultimo_error, contexto FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 ORDER BY created_at, tipo`, [p.id]);
const conSub = async (slug = 'esencial') => {
  const m = await b.crearPersona();
  const sub = `sub_06b_${++n}`;
  await b.activar(m, slug, { id: sub, fin: '2099-01-01' });
  const mem = (await b.fila<{ id: string }>(`SELECT id FROM membresias WHERE usuario_id = $1 AND stripe_subscription_id = $2`, [m.id, sub])).id;
  return { m, sub, mem };
};
const rpc = <T = Record<string, unknown>>(sql: string, params: unknown[]) => b.fila<{ r: T }>(sql, params).then((x) => x.r);
const preparar = (id: string) => rpc<{ ejecutar: boolean; estado?: string; motivo?: string; idempotency_key?: string; tipo?: string }>('SELECT operacion_suscripcion_preparar($1) AS r', [id]);
const resultado = (id: string, ok: boolean, err: string | null = null) => rpc(`SELECT operacion_suscripcion_resultado($1, $2, $3, '{}'::jsonb) AS r`, [id, ok, err]);
const pendientes = (p: Persona) => b.como(p, () => b.filas<{ tipo: string; fuente: string; fuente_id: string; severidad: string; accion: string; detalle: string | null }>(
  `SELECT tipo, fuente, fuente_id, severidad, accion, detalle FROM v_pendientes_operativos WHERE fuente = 'stripe_operaciones_suscripcion'`));
const tier = (slug: string) => b.tierId(slug);
const avisosAdmin = (titulo: string) => b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND titulo = $2`, [admin.id, titulo]).then((x) => x.n);

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('FR-15 · cambio de plan del miembro', () => {
  const registrar = async (opId: string, m: Persona, mem: string, slug: string, dir = 'upgrade') =>
    rpc<{ id: string; estado: string; existente: boolean }>('SELECT cambio_plan_registrar($1, $2, $3, $4, $5) AS r', [opId, m.id, mem, await tier(slug), dir]);
  const cerrar = (opId: string, estado: string, codigo: string) =>
    rpc<{ estado: string; idempotente?: boolean }>(`SELECT cambio_plan_resultado($1, $2, $3, '{}'::jsonb) AS r`, [opId, estado, codigo]);
  const cambiarTier = (opId: string, m: Persona, mem: string, sub: string, slug: string) =>
    b.fila('SELECT cambiar_tier_membresia($1, $2, $3, (SELECT id FROM tiers WHERE slug = $4 AND tenant_id = $5), $6, $7::jsonb, $8)',
      [opId, m.id, mem, slug, b.tenantId, sub, '{}', m.id]);

  it('1/9 · la intención queda durable con identidad = operation_id y el tier destino (sin PII ni payloads)', async () => {
    const { m, mem, sub } = await conSub();
    const op = randomUUID();
    expect(await registrar(op, m, mem, 'premium')).toMatchObject({ estado: 'pendiente', existente: false });
    const [o] = await ops(m);
    expect(o).toMatchObject({ tipo: 'cambiar_plan', causa: 'cambio_plan_miembro', estado: 'pendiente', operation_key: `cambiar_plan:${op}` });
    expect(o.contexto).toEqual({ operation_id: op, tier_destino: await tier('premium'), tier_origen: await tier('esencial'), direccion: 'upgrade' });
    expect((await b.fila<{ s: string }>('SELECT stripe_subscription_id AS s FROM stripe_operaciones_suscripcion WHERE id = $1', [o.id])).s).toBe(sub);
  });

  it('2/7 · misma operación = misma fila; otra intención con la misma operación = conflicto; membresía ajena = rechazo', async () => {
    const { m, mem } = await conSub();
    const op = randomUUID();
    const r1 = await registrar(op, m, mem, 'premium');
    expect(await registrar(op, m, mem, 'premium')).toMatchObject({ id: r1.id, existente: true });
    expect(await ops(m)).toHaveLength(1);
    await expect(registrar(op, m, mem, 'esencial')).rejects.toThrow(/EKKO_OPERACION_CONFLICTO/);
    const otro = await conSub();
    await expect(registrar(randomUUID(), otro.m, mem, 'premium')).rejects.toThrow(/EKKO_MEMBRESIA_INVALIDA/);
  });

  it('3/10 · `aplicada` solo cuando EKKO convergió (tier destino en la membresía); idempotente', async () => {
    const { m, mem, sub } = await conSub();
    const op = randomUUID();
    await registrar(op, m, mem, 'premium');
    await expect(cerrar(op, 'aplicada', 'convergido')).rejects.toThrow(/EKKO_SIN_CONVERGENCIA/);
    await cambiarTier(op, m, mem, sub, 'premium');
    expect(await cerrar(op, 'aplicada', 'convergido')).toMatchObject({ estado: 'aplicada' });
    expect(await cerrar(op, 'aplicada', 'convergido')).toMatchObject({ idempotente: true });
    expect(await pendientes(admin)).toEqual([]);
  });

  it('4/6 · Stripe sí y EKKO no, o resultado desconocido: `fallida`, visible (revisar, no reintentar) y avisa UNA vez', async () => {
    const { m, mem } = await conSub();
    const op = randomUUID();
    await registrar(op, m, mem, 'premium');
    const antes = await avisosAdmin('Un cambio de plan quedó sin confirmar');
    expect(await cerrar(op, 'fallida', 'resultado_desconocido')).toMatchObject({ estado: 'fallida' });
    await cerrar(op, 'fallida', 'db_pendiente');
    expect(await avisosAdmin('Un cambio de plan quedó sin confirmar')).toBe(antes + 1);
    const [o] = await ops(m);
    expect(o).toMatchObject({ estado: 'fallida', ultimo_error: 'db_pendiente' });
    const [p] = (await pendientes(admin)).filter((x) => x.fuente_id === o.id);
    expect(p).toMatchObject({ tipo: 'cambiar_plan', severidad: 'media', accion: 'revisar_cambio_plan' });
    await expect(cerrar(op, 'fallida', 'Error: card_declined en Stripe')).rejects.toThrow(/EKKO_CODIGO_INVALIDO/);
  });

  it('5 · rechazo definitivo de Stripe (cobro) = `descartada`, silencioso; el reintento sin efecto la reabre', async () => {
    const { m, mem } = await conSub();
    const op = randomUUID();
    await registrar(op, m, mem, 'premium');
    await cerrar(op, 'descartada', 'cobro_fallido');
    const [d] = await ops(m);
    expect(d).toMatchObject({ estado: 'descartada', motivo_descarte: 'cobro_fallido' });
    expect((await pendientes(admin)).filter((x) => x.fuente_id === d.id)).toEqual([]);
    expect(await registrar(op, m, mem, 'premium')).toMatchObject({ estado: 'pendiente', existente: true });
  });

  it('8 · el ejecutor genérico jamás ejecuta ni asienta un cambio de plan; el panel no lo reintenta (sí lo descarta con nota)', async () => {
    const { m, mem } = await conSub();
    const op = randomUUID();
    const { id } = await registrar(op, m, mem, 'premium');
    expect(await preparar(id)).toMatchObject({ ejecutar: false, estado: 'pendiente', motivo: 'lo_ejecuta_el_miembro' });
    expect((await ops(m))[0].estado).toBe('pendiente');
    await expect(resultado(id, true)).rejects.toThrow(/EKKO_OPERACION_INVALIDA/);
    await cerrar(op, 'fallida', 'requiere_revision');
    await expect(b.como(admin, () => b.fila(`SELECT staff_reintentar_operacion_cobro($1, 'Lo reintento desde el panel')`, [id]))).rejects.toThrow(/EKKO_OPERACION_NO_REINTENTABLE/);
    await b.como(admin, () => b.fila(`SELECT staff_descartar_operacion_cobro($1, 'Revisado en Stripe: no se aplicó')`, [id]));
    expect((await ops(m))[0]).toMatchObject({ estado: 'descartada', motivo_descarte: 'descartada_por_admin' });
  });

  it('una intención atascada (el proceso murió antes de cerrar) se ve tras 1 h', async () => {
    const { m, mem } = await conSub();
    const { id } = await registrar(randomUUID(), m, mem, 'premium');
    await b.db.query(`ALTER TABLE stripe_operaciones_suscripcion DISABLE TRIGGER trg_stripe_operaciones_suscripcion_guardia`);
    await b.db.query(`UPDATE stripe_operaciones_suscripcion SET created_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    await b.db.query(`ALTER TABLE stripe_operaciones_suscripcion ENABLE TRIGGER trg_stripe_operaciones_suscripcion_guardia`);
    expect((await pendientes(admin)).find((x) => x.fuente_id === id)).toMatchObject({ tipo: 'cambiar_plan', accion: 'revisar_cambio_plan' });
  });
});

describe('FR-16 · baja y reactivación pedidas por el miembro', () => {
  const programar = (m: Persona, cancelar: boolean, op = randomUUID()) =>
    b.como(m, () => rpc<{ operacion_id: string; cancel_at_period_end: boolean; idempotente: boolean; usuario_id: string }>(
      'SELECT miembro_programar_renovacion($1, $2) AS r', [cancelar, op]));
  const capeLocal = (mem: string) => b.fila<{ c: boolean }>('SELECT cancel_at_period_end AS c FROM membresias WHERE id = $1', [mem]).then((x) => x.c);

  it('12/13 · baja: intención LOCAL (cancel_at_period_end) + operación + evidencia, en una transacción; el derecho sigue', async () => {
    const { m, mem } = await conSub();
    const r = await programar(m, true);
    expect(r).toMatchObject({ cancel_at_period_end: true, idempotente: false, usuario_id: m.id });
    expect(await capeLocal(mem)).toBe(true);
    expect((await ops(m))[0]).toMatchObject({ tipo: 'cancelar_fin_periodo', causa: 'baja_miembro', estado: 'pendiente' });
    expect((await b.fila<{ status: string }>('SELECT status FROM membresias WHERE id = $1', [mem])).status).toBe('activa');
    expect(await b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE accion = 'baja_programada_por_miembro' AND actor_usuario_id = $1`, [m.id])).toEqual({ n: 1 });
  });

  it('14/18 · el ejecutor la aplica con llave por operación; misma operación = misma fila; otra acción con la misma = conflicto', async () => {
    const { m } = await conSub();
    const op = randomUUID();
    const r = await programar(m, true, op);
    expect((await programar(m, true, op))).toMatchObject({ operacion_id: r.operacion_id, idempotente: true });
    await expect(programar(m, false, op)).rejects.toThrow(/EKKO_OPERACION_CONFLICTO/);
    const p = await preparar(r.operacion_id);
    expect(p).toMatchObject({ ejecutar: true, tipo: 'cancelar_fin_periodo', idempotency_key: `ekko:renovacion_miembro:${op}:1` });
    await resultado(r.operacion_id, true);
    expect((await ops(m))[0].estado).toBe('aplicada');
    expect(await pendientes(admin)).toEqual(expect.not.arrayContaining([expect.objectContaining({ fuente_id: r.operacion_id })]));
  });

  it('15/16/17 · Stripe falla o no responde: la intención ya quedó, la operación queda `fallida` y visible, se reintenta', async () => {
    const { m } = await conSub();
    const r = await programar(m, true);
    await preparar(r.operacion_id);
    await resultado(r.operacion_id, false, 'api_connection_error:timeout');
    expect((await ops(m))[0]).toMatchObject({ estado: 'fallida' });
    expect((await pendientes(admin)).find((x) => x.fuente_id === r.operacion_id)).toMatchObject({ severidad: 'media', accion: 'vigilar_operacion' });
    expect(await preparar(r.operacion_id)).toMatchObject({ ejecutar: true, idempotency_key: expect.stringMatching(/:2$/) });
  });

  it('19/20/24 · reactivar: cancel_at_period_end=false local + operación reanudar_renovacion; la baja pendiente se descarta sola', async () => {
    const { m, mem } = await conSub();
    const baja = await programar(m, true);
    const re = await programar(m, false);
    expect(await capeLocal(mem)).toBe(false);
    expect(await preparar(baja.operacion_id)).toMatchObject({ ejecutar: false, motivo: 'cancelacion_revertida' });
    const p = await preparar(re.operacion_id);
    expect(p).toMatchObject({ ejecutar: true, tipo: 'reanudar_renovacion' });
    await resultado(re.operacion_id, true);
    expect((await ops(m)).map((o) => [o.tipo, o.causa, o.estado])).toEqual([
      ['cancelar_fin_periodo', 'baja_miembro', 'descartada'], ['reanudar_renovacion', 'reactivacion_miembro', 'aplicada']
    ]);
  });

  it('21 · revocación: ni baja ni reactivación por el miembro', async () => {
    const { m } = await conSub();
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    await expect(programar(m, false)).rejects.toThrow(/EKKO_CUENTA_REVOCADA/);
  });

  it('22 · sanción: puede dar de baja (reduce cobro) pero NO reactivar; una reactivación en espera se descarta si lo sancionan', async () => {
    const { m } = await conSub();
    const re0 = await (async () => { await programar(m, true); return programar(m, false); })();
    await b.db.query(`UPDATE usuarios SET sancionado_at = now(), sancion_motivo = 'Daños' WHERE id = $1`, [m.id]);
    expect(await preparar(re0.operacion_id)).toMatchObject({ ejecutar: false, motivo: 'sancion_vigente' });
    expect(await programar(m, true)).toMatchObject({ cancel_at_period_end: true });
    await expect(programar(m, false)).rejects.toThrow(/EKKO_CUENTA_RESTRINGIDA/);
  });

  it('23 · una baja que programó el ESTUDIO (02H) no la revierte el miembro', async () => {
    const { m } = await conSub();
    await b.como(recep, () => b.fila('SELECT staff_cancelar_membresia($1, false, $2)', [m.id, 'Se muda de ciudad']));
    await expect(programar(m, false)).rejects.toThrow(/EKKO_BAJA_DEL_ESTUDIO/);
  });

  it('autoridad: el staff no usa la RPC del miembro; sin suscripción no hay nada que gestionar', async () => {
    await expect(b.como(recep, () => b.fila('SELECT miembro_programar_renovacion(true, $1)', [randomUUID()]))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    const sinSub = await b.crearPersona();
    await expect(programar(sinSub, true)).rejects.toThrow(/EKKO_SIN_SUSCRIPCION/);
  });
});

describe('FR-17 · suscripción anterior tras activar otra (webhook)', () => {
  const registrarAnterior = (m: Persona, anterior: string, nueva: string | null, evento = `evt_${++n}`) =>
    rpc<{ id: string; estado: string }>('SELECT registrar_cancelacion_suscripcion_anterior($1, $2, $3, $4) AS r', [m.id, anterior, nueva, evento]);

  it('25/26/27/33 · identidad determinista por suscripción anterior: los reintentos del webhook convergen en UNA fila; contexto sin payload', async () => {
    const { m, sub } = await conSub();
    const r1 = await registrarAnterior(m, sub, 'sub_nueva_x', 'evt_a');
    const r2 = await registrarAnterior(m, sub, 'sub_nueva_x', 'evt_a');
    const r3 = await registrarAnterior(m, sub, 'sub_nueva_y', 'evt_b');
    expect(new Set([r1.id, r2.id, r3.id]).size).toBe(1);
    const lista = (await ops(m)).filter((o) => o.causa === 'suscripcion_anterior');
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ tipo: 'cancelar_suscripcion', operation_key: `cancelar_anterior:${sub}`, estado: 'pendiente' });
    expect(lista[0].contexto).toEqual({ sub_nueva: 'sub_nueva_x', evento: 'evt_a' });
  });

  it('28 · nunca una suscripción ajena (de otro miembro o desconocida), ni la nueva como anterior', async () => {
    const a = await conSub();
    const otro = await conSub();
    await expect(registrarAnterior(a.m, otro.sub, 'sub_z')).rejects.toThrow(/EKKO_SUSCRIPCION_AJENA/);
    await expect(registrarAnterior(a.m, 'sub_inexistente', 'sub_z')).rejects.toThrow(/EKKO_SUSCRIPCION_AJENA/);
    await expect(registrarAnterior(a.m, a.sub, a.sub)).rejects.toThrow(/EKKO_SUSCRIPCION_INVALIDA/);
  });

  it('mientras la membresía anterior siga viva (activación en curso), espera sin descartarse; tras activar la nueva, se ejecuta', async () => {
    const { m, sub } = await conSub();
    const { id } = await registrarAnterior(m, sub, 'sub_nueva_06b_a');
    expect(await preparar(id)).toMatchObject({ ejecutar: false, estado: 'pendiente', motivo: 'membresia_anterior_vigente' });
    expect((await ops(m))[0].estado).toBe('pendiente');
    await b.activar(m, 'premium', { id: 'sub_nueva_06b_a', fin: '2099-01-01' });
    const p = await preparar(id);
    expect(p).toMatchObject({ ejecutar: true, tipo: 'cancelar_suscripcion', idempotency_key: `ekko:cancelar_anterior:${sub}:1` });
  });

  it('29/35 · éxito: `aplicada`, silenciosa', async () => {
    const { m, sub } = await conSub();
    const { id } = await registrarAnterior(m, sub, 'sub_nueva_06b_b');
    await b.activar(m, 'premium', { id: 'sub_nueva_06b_b', fin: '2099-01-01' });
    await preparar(id);
    await resultado(id, true);
    expect((await pendientes(admin)).find((x) => x.fuente_id === id)).toBeUndefined();
  });

  it('30/31/32/37 · fallo o ambigüedad: `fallida`, ALTA desde el primer fallo, aviso de posible doble cobro, la reintenta el cron', async () => {
    const { m, sub } = await conSub();
    const { id } = await registrarAnterior(m, sub, 'sub_nueva_06b_c');
    await b.activar(m, 'premium', { id: 'sub_nueva_06b_c', fin: '2099-01-01' });
    await preparar(id);
    const antes = await avisosAdmin('Posible doble cobro: no se canceló la suscripción anterior');
    await resultado(id, false, 'api_error:timeout');
    expect(await avisosAdmin('Posible doble cobro: no se canceló la suscripción anterior')).toBe(antes + 1);
    const item = (await pendientes(admin)).find((x) => x.fuente_id === id);
    expect(item).toMatchObject({ tipo: 'cancelar_suscripcion', severidad: 'alta', accion: 'vigilar_operacion' });
    expect(item?.detalle).toMatch(/^suscripcion_anterior · api_error:timeout/);
    expect(await preparar(id)).toMatchObject({ ejecutar: true });
  });

  it('una suscripción nunca respalda dos membresías (UNIQUE): la cancelación de la anterior no puede pegarle a otra', async () => {
    const u = await b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'membresias_stripe_subscription_id_key' AND contype = 'u'`);
    expect(u.n).toBe(1);
  });
});

describe('frontera', () => {
  it('39/41/43/44 · RPC de servicio solo service_role; la del miembro, authenticated con guardia; nadie escribe operaciones por REST', async () => {
    const firmas: Array<[string, boolean]> = [
      ['cambio_plan_registrar(uuid, uuid, uuid, uuid, text)', false],
      ['cambio_plan_resultado(uuid, text, text, jsonb)', false],
      ['registrar_cancelacion_suscripcion_anterior(uuid, text, text, text)', false],
      ['miembro_programar_renovacion(boolean, uuid)', true]
    ];
    for (const [f, auth] of firmas) {
      const p = await b.fila<{ an: boolean; au: boolean; s: boolean; cfg: string[] }>(
        `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS an, has_function_privilege('authenticated', $1, 'EXECUTE') AS au,
                has_function_privilege('service_role', $1, 'EXECUTE') AS s, (SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure) AS cfg`, [f]);
      expect([f, p.an, p.au, p.s, p.cfg]).toEqual([f, false, auth, true, ['search_path=public']]);
    }
    const { m } = await conSub();
    await expect(b.como(m, () => b.db.query(`INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, stripe_subscription_id, tipo, causa, operation_key) VALUES ($1, $2, 's', 'cambiar_plan', 'cambio_plan_miembro', 'x')`, [b.tenantId, m.id]))).rejects.toThrow(/permission denied/);
    await expect(b.como(admin, () => b.fila(`SELECT cambio_plan_resultado($1, 'aplicada', 'x', '{}'::jsonb)`, [randomUUID()]))).rejects.toThrow(/permission denied/);
  });

  it('42 · el miembro solo actúa sobre SU membresía (el actor sale del servidor)', async () => {
    const a = await conSub();
    const otro = await conSub();
    await b.como(a.m, () => b.fila('SELECT miembro_programar_renovacion(true, $1)', [randomUUID()]));
    expect(await b.fila<{ c: boolean }>('SELECT cancel_at_period_end AS c FROM membresias WHERE id = $1', [otro.mem])).toEqual({ c: false });
  });

  it('40 · recepción y miembros no ven Operación; los tipos y causas viejos siguen válidos', async () => {
    const { m } = await conSub();
    expect(await pendientes(recep)).toEqual([]);
    expect(await pendientes(m)).toEqual([]);
    const c = await b.fila<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'stripe_operaciones_suscripcion_causa_check'`);
    for (const causa of ['sancion', 'levantar_sancion', 'revocacion', 'baja_inmediata', 'pausa_staff', 'reactivacion_staff', 'baja_fin_periodo']) expect(c.d).toContain(causa);
  });
});
