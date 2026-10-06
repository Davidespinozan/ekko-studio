// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-02H · migración 20261012100000 contra Postgres real (PGlite).
 *
 * Las operaciones de cobro del STAFF (pausar, reactivar, baja al fin del periodo)
 * quedan escritas en `stripe_operaciones_suscripcion` en la MISMA transacción que
 * la transición local, con identidad por operación lógica, y el ejecutor las
 * revalida por causa antes de tocar Stripe. Aquí Stripe es `preparar`+`resultado`
 * (lo que el ejecutor hace alrededor de la llamada), nunca una llamada real.
 */

let b: BaseDePrueba;
let recep: Persona;
let recepB: Persona;
let n = 0;

type Op = { id: string; tipo: string; causa: string; estado: string; motivo_descarte: string | null; operation_key: string; intentos: number };

const conSub = async () => {
  const m = await b.crearPersona();
  const sub = `sub_02h_${++n}`;
  await b.activar(m, 'esencial', { id: sub, fin: '2099-01-01' });
  const mem = (await b.fila<{ id: string }>(`SELECT id FROM membresias WHERE usuario_id = $1`, [m.id])).id;
  return { m, sub, mem };
};
const ops = (m: Persona) => b.filas<Op>(
  `SELECT id, tipo, causa, estado, motivo_descarte, operation_key, intentos FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 ORDER BY created_at, tipo`, [m.id]);
const resumen = async (m: Persona) => (await ops(m)).map((o) => [o.tipo, o.causa, o.estado, o.motivo_descarte]);
const pausar = (m: Persona, p: boolean, quien: Persona = recep, motivo = 'Viaje largo') =>
  b.como(quien, () => b.fila<{ r: Record<string, unknown> }>('SELECT staff_pausar_membresia($1, $2, $3) AS r', [m.id, p, motivo])).then((x) => x.r);
const baja = (m: Persona, inmediata: boolean) =>
  b.como(recep, () => b.fila<{ r: Record<string, unknown> }>('SELECT staff_cancelar_membresia($1, $2, $3) AS r', [m.id, inmediata, 'Se muda de ciudad'])).then((x) => x.r);
const sancionar = (m: Persona) => b.db.query(`UPDATE usuarios SET sancionado_at = now(), sancion_motivo = 'Daños' WHERE id = $1`, [m.id]);
const levantar = (m: Persona) => b.db.query(`UPDATE usuarios SET sancionado_at = NULL, sancion_motivo = NULL, status = 'activo' WHERE id = $1`, [m.id]);
const preparar = (id: string) => b.fila<{ p: { ejecutar: boolean; estado?: string; motivo?: string; idempotency_key?: string; tipo?: string } }>('SELECT operacion_suscripcion_preparar($1) AS p', [id]).then((x) => x.p);
const resultado = (id: string, ok: boolean, err: string | null = null) =>
  b.fila<{ r: Record<string, unknown> }>(`SELECT operacion_suscripcion_resultado($1, $2, $3, '{}'::jsonb) AS r`, [id, ok, err]).then((x) => x.r);
/** El ejecutor con Stripe "OK": prepara y asienta todo lo pendiente del miembro. */
const aplicar = async (m: Persona) => {
  for (const o of (await ops(m)).filter((x) => ['pendiente', 'fallida'].includes(x.estado))) {
    const p = await preparar(o.id);
    if (p.ejecutar) await resultado(o.id, true);
  }
};
const mem = (m: Persona) => b.fila<{ status: string; intencion: boolean; cape: boolean }>(
  `SELECT status, pausa_comercial_at IS NOT NULL AS intencion, cancel_at_period_end AS cape FROM membresias WHERE usuario_id = $1 ORDER BY created_at DESC LIMIT 1`, [m.id]);
const eco = (sub: string, estado: 'pausada' | 'activa') => b.fila(`SELECT sync_membresia_stripe($1, $2, '2099-02-01', NULL, now())`, [sub, estado]);

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
  await b.db.query(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-02h', 'Otro', 'activo')`);
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('recep-b-02h@test.mx', '{"tenant_slug":"b-02h"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'recepcionista', status = 'activo', identidad_completa = true, contrato_firmado = true WHERE auth_id = $1 RETURNING id`, [a.id]);
  recepB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('pausa del staff: intención + operación en la misma transacción', () => {
  it('1 · pausar deja la operación suspender_cobro/pausa_staff pendiente con llave por pausa; el ejecutor la aplica una vez', async () => {
    const { m, mem: id } = await conSub();
    expect(await pausar(m, true)).toMatchObject({ success: true, operacion_cobro: true });
    const [o] = await ops(m);
    expect([o.tipo, o.causa, o.estado]).toEqual(['suspender_cobro', 'pausa_staff', 'pendiente']);
    expect(o.operation_key).toMatch(new RegExp(`^pausar_staff:${id}:\\d+$`));
    const p = await preparar(o.id);
    expect(p.ejecutar).toBe(true);
    expect(p.idempotency_key).toBe(`ekko:${o.operation_key}:1`);
    await resultado(o.id, true);
    expect((await ops(m))[0].estado).toBe('aplicada');
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: true });
  });

  it('6 · 17 · pausar otra vez (petición duplicada) es idempotente: ni segunda operación ni segundo efecto', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await aplicar(m);
    expect(await pausar(m, true)).toMatchObject({ success: true, idempotente: true });
    expect(await ops(m)).toHaveLength(1);
    const audit = await b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE target_id = $1 AND accion = 'membresia_pausada'`, [m.id]);
    expect(audit.n).toBe(1);
  });

  it('2 · 3 · 5 · Stripe falla o es ambiguo: la pausa en EKKO queda; la operación queda fallida y el reintento usa la MISMA operación con llave por intento', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    const [o] = await ops(m);
    await preparar(o.id);
    expect(await resultado(o.id, false, 'StripeConnectionError:timeout')).toMatchObject({ estado: 'fallida' });
    expect(await mem(m)).toMatchObject({ status: 'pausada', intencion: true });
    const p2 = await preparar(o.id);
    expect(p2).toMatchObject({ ejecutar: true, idempotency_key: `ekko:${o.operation_key}:2` });
    await resultado(o.id, true);
    expect(await resumen(m)).toEqual([['suspender_cobro', 'pausa_staff', 'aplicada', null]]);
  });

  it('4 · el proceso muere tras la RPC: la operación sigue pendiente para el ejecutor (cron / sincronizar); si falla, Operación la ve', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    const [o] = await ops(m);
    expect(o.estado).toBe('pendiente'); // la tomará cron-expirar-membresias / staff-sincronizar-cobro
    await preparar(o.id);
    await resultado(o.id, false, 'StripeConnectionError:timeout');
    const admin = await b.crearPersona({ rol: 'admin' });
    const v = await b.como(admin, () => b.filas<{ tipo: string; accion: string }>(`SELECT tipo, accion FROM v_pendientes_operativos WHERE fuente = 'stripe_operaciones_suscripcion' AND usuario_id = $1`, [m.id]));
    expect(v).toEqual([{ tipo: 'suspender_cobro', accion: 'vigilar_operacion' }]);
  });

  it('19 · pausa → reactivación antes de que el ejecutor aplique: la pausa se descarta (reactivada) y queda la reanudación; el ejecutor no reanuda lo que nunca se pausó en Stripe… salvo que la pausa sí se haya aplicado', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await pausar(m, false);
    expect(await resumen(m)).toEqual([
      ['suspender_cobro', 'pausa_staff', 'descartada', 'reactivada'],
      ['reanudar_cobro', 'reactivacion_staff', 'pendiente', null]
    ]);
    // Reanudar sobre una suscripción que nunca se pausó es inocuo en Stripe (pause_collection ya null).
    await aplicar(m);
    expect((await ops(m))[1].estado).toBe('aplicada');
  });
});

describe('reactivación del staff', () => {
  it('7 · 14 · reactivar deja reanudar_cobro/reactivacion_staff con llave por la pausa que levanta; repetir es idempotente', async () => {
    const { m, mem: id } = await conSub();
    await pausar(m, true);
    await aplicar(m);
    const pausa = await b.fila<{ e: string }>(`SELECT floor(extract(epoch FROM pausa_comercial_at) * 1000)::bigint::text AS e FROM membresias WHERE id = $1`, [id]);
    expect(await pausar(m, false)).toMatchObject({ success: true, operacion_cobro: true });
    const r = (await ops(m)).find((o) => o.tipo === 'reanudar_cobro')!;
    expect([r.causa, r.estado, r.operation_key]).toEqual(['reactivacion_staff', 'pendiente', `reactivar_staff:${id}:${pausa.e}`]);
    expect(await pausar(m, false)).toMatchObject({ idempotente: true });
    expect(await ops(m)).toHaveLength(2);
    await aplicar(m);
    expect(await mem(m)).toMatchObject({ status: 'activa', intencion: false });
  });

  it('8 · 10 · Stripe falla al reanudar: EKKO queda reactivada, la operación fallida se reintenta con la misma identidad', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await aplicar(m);
    await pausar(m, false);
    const r = (await ops(m)).find((o) => o.tipo === 'reanudar_cobro')!;
    await preparar(r.id);
    await resultado(r.id, false, 'StripeAPIError:500');
    expect(await mem(m)).toMatchObject({ status: 'activa', intencion: false });
    expect((await preparar(r.id))).toMatchObject({ ejecutar: true, idempotency_key: `ekko:${r.operation_key}:2` });
  });

  it('11 · reactivar SANCIONADO: quita la intención, NO crea reanudación; se asegura la suspensión de la sanción; al levantarla se reanuda', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await aplicar(m);
    await sancionar(m);
    expect(await pausar(m, false)).toMatchObject({ cobro_suspendido_por_sancion: true, operacion_cobro: false });
    expect((await ops(m)).some((o) => o.tipo === 'reanudar_cobro')).toBe(false);
    // La pausa del staff aplicada ya tiene a Stripe en pausa: la sanción no duplica la suspensión (lo último aplicado es una suspensión).
    expect(await resumen(m)).toEqual([['suspender_cobro', 'pausa_staff', 'aplicada', null]]);
    await levantar(m);
    expect((await ops(m)).map((o) => [o.tipo, o.causa, o.estado])).toEqual([
      ['suspender_cobro', 'pausa_staff', 'aplicada'],
      ['reanudar_cobro', 'levantar_sancion', 'pendiente']
    ]);
  });

  it('12 · 13 · pausar estando SANCIONADO (cobro ya suspendido): la operación del staff se aplica igual (idempotente en Stripe); levantar la sanción no reanuda (EKKO-138)', async () => {
    const { m, sub } = await conSub();
    await sancionar(m);
    await aplicar(m);
    await eco(sub, 'pausada');
    await pausar(m, true);
    expect(await resumen(m)).toEqual([
      ['suspender_cobro', 'sancion', 'aplicada', null],
      ['suspender_cobro', 'pausa_staff', 'pendiente', null]
    ]);
    await aplicar(m);
    await levantar(m);
    // Nada se reanuda: lo último aplicado es la pausa del staff y la intención sigue.
    expect((await ops(m)).some((o) => o.tipo === 'reanudar_cobro')).toBe(false);
    // Y la reactivación explícita sí reanuda.
    await pausar(m, false);
    expect((await ops(m)).filter((o) => o.tipo === 'reanudar_cobro').map((o) => [o.causa, o.estado])).toEqual([
      ['reactivacion_staff', 'pendiente']
    ]);
  });

  it('13b · la sanción llega mientras la reanudación del staff espera: el ejecutor la descarta (sancion_vigente)', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await aplicar(m);
    await pausar(m, false);
    await sancionar(m);
    await aplicar(m);
    const r = (await ops(m)).find((o) => o.tipo === 'reanudar_cobro')!;
    expect([r.estado, r.motivo_descarte]).toEqual(['descartada', 'sancion_vigente']);
  });
});

describe('baja al fin del periodo', () => {
  it('baja programada deja cancelar_fin_periodo/baja_fin_periodo (una por membresía); el ejecutor la aplica; repetirla es inocua', async () => {
    const { m, mem: id } = await conSub();
    expect(await baja(m, false)).toMatchObject({ success: true, inmediata: false });
    expect(await mem(m)).toMatchObject({ status: 'activa', cape: true });
    const [o] = await ops(m);
    expect([o.tipo, o.causa, o.estado, o.operation_key]).toEqual(['cancelar_fin_periodo', 'baja_fin_periodo', 'pendiente', `cancelar_fin:${id}`]);
    expect(await preparar(o.id)).toMatchObject({ ejecutar: true, tipo: 'cancelar_fin_periodo' });
    await resultado(o.id, true);
    await baja(m, false);
    expect(await ops(m)).toHaveLength(1);
  });

  it('si la membresía termina antes de aplicarse (baja inmediata posterior / fin desde Stripe), la operación se descarta', async () => {
    const { m, sub } = await conSub();
    await baja(m, false);
    await b.fila(`SELECT sync_membresia_stripe($1, 'cancelada', NULL, NULL, now())`, [sub]);
    await aplicar(m);
    const o = (await ops(m)).find((x) => x.tipo === 'cancelar_fin_periodo')!;
    expect([o.estado, o.motivo_descarte]).toEqual(['descartada', 'membresia_no_vigente']);
  });

  it('baja inmediata (R2-B) sigue igual: cancelar_suscripcion/baja_inmediata por el trigger', async () => {
    const { m } = await conSub();
    await baja(m, true);
    expect(await resumen(m)).toEqual([['cancelar_suscripcion', 'baja_inmediata', 'pendiente', null]]);
  });
});

describe('terminal, webhook y fronteras', () => {
  it('14 · revocación mientras la pausa del staff espera: se descarta (cuenta_revocada) y queda la cancelación (R1/EKKO-130)', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    await aplicar(m);
    const r = await resumen(m);
    expect(r).toContainEqual(['suspender_cobro', 'pausa_staff', 'descartada', 'cuenta_revocada']);
    expect(r.some((x) => x[0] === 'cancelar_suscripcion' && x[1] === 'revocacion')).toBe(true);
  });

  it('15 · 16 · el eco del webhook antes o después de aplicar no crea ni borra operaciones ni intención', async () => {
    const { m, sub } = await conSub();
    await pausar(m, true);
    await eco(sub, 'pausada'); // antes de aplicar
    expect(await resumen(m)).toEqual([['suspender_cobro', 'pausa_staff', 'pendiente', null]]);
    await aplicar(m);
    await eco(sub, 'pausada'); // después
    expect(await resumen(m)).toEqual([['suspender_cobro', 'pausa_staff', 'aplicada', null]]);
    expect(await mem(m)).toMatchObject({ intencion: true });
  });

  it('18 · aislamiento: recepción de otro estudio no pausa ni da de baja; nadie escribe operaciones por REST', async () => {
    const { m } = await conSub();
    await expect(pausar(m, true, recepB)).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
    await expect(b.como(recepB, () => b.fila('SELECT staff_cancelar_membresia($1, false, $2)', [m.id, 'Se muda de ciudad']))).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
    await expect(b.como(recep, () => b.fila(`INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, stripe_subscription_id, tipo, causa, operation_key) VALUES ($1, $2, 'x', 'suspender_cobro', 'pausa_staff', 'k')`, [b.tenantId, m.id]))).rejects.toThrow(/permission denied/);
    await expect(b.db.query(`INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, stripe_subscription_id, tipo, causa, operation_key) VALUES ($1, $2, 'x', 'suspender_cobro', 'causa_inventada', 'k2')`, [b.tenantId, m.id])).rejects.toThrow(/causa_check/);
  });

  it('20 · con la operación en vuelo, PKG-03B no la duplica como discrepancia (la evidencia ya está en Operación)', async () => {
    const { m } = await conSub();
    await pausar(m, true);
    const enVuelo = await b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 AND estado IN ('pendiente', 'fallida')`, [m.id]);
    expect(enVuelo.n).toBe(1); // compararEstudio lee exactamente este estado (operacion_en_vuelo)
  });
});
