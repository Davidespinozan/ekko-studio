// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-03A · migración 20261009100000 contra Postgres real (PGlite).
 *
 *  Entrega:    el correo tiene ciclo de vida (reintentable con backoff, máx. 3,
 *              terminal con motivo, nada se pierde por la ventana); el push se
 *              asienta después de intentar, con resultado honesto.
 *  Evidencia:  los correos directos del webhook quedan en `correos_directos`.
 *  Cierre:     eventos de Stripe y operaciones de cobro se resuelven por RPC de
 *              admin, con nota y auditoría, sin reescribir la evidencia.
 *  Vista:      `v_pendientes_operativos` deriva de las autoridades, admin de su
 *              estudio, sin copiar nada.
 */

const TIPOS = ['reserva_confirmada', 'aviso_manual'];

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
const aviso = (p: Persona, tipo = 'reserva_confirmada', hace = '0 minutes') =>
  b.fila<{ id: string }>(
    `INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, creada_at)
     SELECT tenant_id, id, $2, 't', 'm', now() - $3::interval FROM usuarios WHERE id = $1 RETURNING id`, [p.id, tipo, hace]).then((x) => x.id);
const correo = (id: string) => b.fila<{
  email_resultado: string | null; email_intentos: number; email_ultimo_error: string | null; seg: number | null;
  email_enviado_at: string | null; email_proveedor_id: string | null;
}>(`SELECT email_resultado, email_intentos, email_ultimo_error, email_enviado_at, email_proveedor_id,
          extract(epoch FROM email_siguiente_at - now())::int AS seg FROM notificaciones WHERE id = $1`, [id]);
const reclamar = () => b.filas<{ id: string; email_intentos: number }>(
  `SELECT id, email_intentos FROM reclamar_correos_pendientes($1::text[], 50, interval '6 hours')`, [TIPOS]);
const resultado = (id: string, r: string, prov: string | null, err: string | null, reint: boolean) =>
  b.fila<{ r: { estado: string; idempotente: boolean } }>(
    'SELECT notificacion_email_resultado($1, $2, $3, $4, $5) AS r', [id, r, prov, err, reint]).then((x) => x.r);
const vencerLease = (id: string) => b.db.query(`UPDATE notificaciones SET email_siguiente_at = now() - interval '1 second' WHERE id = $1`, [id]);
const pendientes = (p: Persona) => b.como(p, () => b.filas<{ dominio: string; tipo: string; fuente: string; fuente_id: string; tenant_id: string; severidad: string; accion: string }>(
  'SELECT dominio, tipo, fuente, fuente_id, tenant_id, severidad, accion FROM v_pendientes_operativos'));

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  m = await b.crearPersona();
  await b.activar(m, 'esencial', { id: 'sub_03a' });
  await b.db.query(`UPDATE tenants SET stripe_account_id = 'acct_a' WHERE id = $1`, [b.tenantId]);

  // Estudio B, con su admin (alta por el trigger de signup, como en producción).
  tenantB = (await b.fila<{ id: string }>(
    `INSERT INTO tenants (slug, nombre, status, stripe_account_id) VALUES ('b-03a', 'Otro', 'activo', 'acct_b') RETURNING id`)).id;
  const a = await b.fila<{ id: string }>(
    `INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-b-03a@test.mx', '{"tenant_slug":"b-03a"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(
    `UPDATE usuarios SET rol = 'admin', status = 'activo', identidad_completa = true, contrato_firmado = true WHERE auth_id = $1 RETURNING id`, [a.id]);
  adminB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('correo de avisos: ciclo de vida', () => {
  it('reclamar cuenta el intento y pone lease: otra corrida inmediata no lo toma', async () => {
    const id = await aviso(m);
    expect((await reclamar()).map((r) => r.id)).toContain(id);
    expect((await reclamar()).map((r) => r.id)).not.toContain(id);
    expect(await correo(id)).toMatchObject({ email_intentos: 1, email_resultado: null });
    await resultado(id, 'aceptado', 're_1', null, false);
  });

  it('transitorio → reintentable con backoff 2 min y 10 min; el tercer fallo es terminal (máx. 3), con motivo', async () => {
    const id = await aviso(m);
    await reclamar();
    expect(await resultado(id, 'fallo', null, 'timeout', true)).toMatchObject({ estado: 'reintentable' });
    let c = await correo(id);
    expect(c).toMatchObject({ email_resultado: 'reintentable', email_ultimo_error: 'timeout', email_enviado_at: null });
    expect(c.seg).toBeGreaterThan(100);
    expect(c.seg).toBeLessThanOrEqual(120);
    // Antes de que toque, no se toma.
    expect((await reclamar()).map((r) => r.id)).not.toContain(id);

    await vencerLease(id);
    expect((await reclamar()).find((r) => r.id === id)?.email_intentos).toBe(2);
    await resultado(id, 'fallo', null, 'http_5xx:503', true);
    c = await correo(id);
    expect(c.seg).toBeGreaterThan(500);
    expect(c.seg).toBeLessThanOrEqual(600);

    await vencerLease(id);
    expect((await reclamar()).find((r) => r.id === id)?.email_intentos).toBe(3);
    expect(await resultado(id, 'fallo', null, 'red', true)).toMatchObject({ estado: 'fallo' });
    expect(await correo(id)).toMatchObject({ email_resultado: 'fallo', email_ultimo_error: 'red', seg: null, email_intentos: 3 });
    await vencerLease(id).catch(() => undefined);
    expect((await reclamar()).map((r) => r.id)).not.toContain(id);
  });

  it('un error permanente termina al primer intento; "aceptado" sin id del proveedor nunca es éxito', async () => {
    const id = await aviso(m);
    await reclamar();
    expect(await resultado(id, 'fallo', null, 'http_4xx:422', false)).toMatchObject({ estado: 'fallo' });
    const id2 = await aviso(m);
    await reclamar();
    expect(await resultado(id2, 'aceptado', null, null, false)).toMatchObject({ estado: 'fallo' });
    expect(await correo(id2)).toMatchObject({ email_resultado: 'fallo', email_ultimo_error: 'aceptado_sin_id', email_enviado_at: null, email_proveedor_id: null });
  });

  it('idempotente: un intento tardío no degrada lo aceptado', async () => {
    const id = await aviso(m);
    await reclamar();
    await resultado(id, 'aceptado', 're_ok', null, false);
    expect(await resultado(id, 'fallo', null, 'timeout', true)).toEqual({ estado: 'aceptado', idempotente: true });
    expect(await correo(id)).toMatchObject({ email_resultado: 'aceptado', email_proveedor_id: 're_ok' });
  });

  it('nada se pierde por la ventana: lo nunca intentado de >6 h queda fallo visible; un reintento viejo sigue cuando le toca', async () => {
    const viejo = await aviso(m, 'reserva_confirmada', '8 hours');
    const reintentoViejo = await aviso(m, 'aviso_manual', '10 hours');
    await b.db.query(`UPDATE notificaciones SET email_intentos = 1, email_resultado = 'reintentable', email_siguiente_at = now() - interval '1 minute' WHERE id = $1`, [reintentoViejo]);
    const tomados = (await reclamar()).map((r) => r.id);
    expect(tomados).toContain(reintentoViejo);
    expect(tomados).not.toContain(viejo);
    expect(await correo(viejo)).toMatchObject({ email_resultado: 'fallo', email_ultimo_error: 'ventana_vencida', email_intentos: 0 });
    await resultado(reintentoViejo, 'aceptado', 're_v', null, false);
  });

  it('el lease vencido con los 3 intentos gastados termina en fallo (la corrida murió en el último)', async () => {
    const id = await aviso(m);
    await b.db.query(`UPDATE notificaciones SET email_intentos = 3, email_siguiente_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await reclamar()).map((r) => r.id)).not.toContain(id);
    expect(await correo(id)).toMatchObject({ email_resultado: 'fallo', email_ultimo_error: 'intentos_agotados' });
  });
});

describe('push: resultado honesto', () => {
  const push = (id: string) => b.fila<{ push_resultado: string | null; push_enviado_at: string | null }>(
    'SELECT push_resultado, push_enviado_at FROM notificaciones WHERE id = $1', [id]);
  const reclamarPush = () => b.filas<{ id: string }>('SELECT id FROM reclamar_push_pendientes(200)');

  it('se reclama con lease; un fallo NO marca enviado y no se vuelve a tomar; enviado sí deja push_enviado_at', async () => {
    const f = await aviso(m, 'no_show');
    const e = await aviso(m, 'no_show');
    const tomados = (await reclamarPush()).map((r) => r.id);
    expect(tomados).toEqual(expect.arrayContaining([f, e]));
    expect((await reclamarPush()).map((r) => r.id)).not.toContain(f);
    await b.fila(`SELECT registrar_resultado_push(ARRAY[$1]::uuid[], 'fallo')`, [f]);
    await b.fila(`SELECT registrar_resultado_push(ARRAY[$1]::uuid[], 'enviado')`, [e]);
    expect(await push(f)).toEqual({ push_resultado: 'fallo', push_enviado_at: null });
    expect((await push(e)).push_enviado_at).not.toBeNull();
    // Solo filas sin resultado: un segundo asiento no cambia nada.
    expect((await b.fila<{ n: number }>(`SELECT registrar_resultado_push(ARRAY[$1]::uuid[], 'enviado') AS n`, [f])).n).toBe(0);
    await b.db.query(`UPDATE notificaciones SET push_intento_at = now() - interval '10 minutes' WHERE id = $1`, [f]);
    expect((await reclamarPush()).map((r) => r.id)).not.toContain(f);
  });

  it('la base no admite "enviado" sin envío ni marca de envío con otro resultado', async () => {
    const id = await aviso(m, 'no_show');
    await expect(b.db.query(`UPDATE notificaciones SET push_resultado = 'fallo', push_enviado_at = now() WHERE id = $1`, [id])).rejects.toThrow(/push_enviado_check/);
    await expect(b.db.query(`UPDATE notificaciones SET push_resultado = 'enviado' WHERE id = $1`, [id])).rejects.toThrow(/push_enviado_check/);
  });

  it('02C por lista blanca: el miembro no toca ninguna columna nueva de entrega', async () => {
    const id = await aviso(m, 'no_show');
    for (const set of ["push_resultado = 'enviado'", 'push_intento_at = now()', 'email_intentos = 9',
      "email_resultado = 'reintentable'", 'email_revisado_at = now()', "email_ultimo_error = 'x'"]) {
      await expect(b.como(m, () => b.fila(`UPDATE notificaciones SET ${set} WHERE id = $1`, [id])), set).rejects.toThrow(/EKKO_AVISO_SOLO_LECTURA/);
    }
    await b.como(m, () => b.fila(`UPDATE notificaciones SET leida = true, leida_at = now() WHERE id = $1`, [id]));
  });
});

describe('correos directos del webhook: evidencia', () => {
  const reg = (key: string, res: string, prov: string | null, err: string | null, tenant = b.tenantId) =>
    b.fila<{ r: string }>(`SELECT registrar_correo_directo($1, $2, $3, 'recibo', 'evt_x', $4, $5, $6) AS r`, [key, tenant, m.id, res, prov, err]).then((x) => x.r);
  const fila = (key: string) => b.fila<{ resultado: string; intentos: number; proveedor_id: string | null; ultimo_error: string | null; enviado_at: string | null }>(
    'SELECT resultado, intentos, proveedor_id, ultimo_error, enviado_at FROM correos_directos WHERE idempotency_key = $1', [key]);

  it('una fila por llave: el reintento suma intento; lo aceptado no se degrada; sin id no hay éxito', async () => {
    const k = 'ekko:email:stripe:evt_d1:recibo';
    expect(await reg(k, 'fallo', null, 'timeout')).toBe('fallo');
    expect(await reg(k, 'aceptado', 're_d', null)).toBe('aceptado');
    expect(await fila(k)).toMatchObject({ resultado: 'aceptado', intentos: 2, proveedor_id: 're_d', ultimo_error: null });
    expect(await reg(k, 'fallo', null, 'red')).toBe('aceptado');
    expect(await fila(k)).toMatchObject({ resultado: 'aceptado', intentos: 2 });
    expect(await reg('ekko:email:stripe:evt_d2:recibo', 'aceptado', null, null)).toBe('fallo');
    expect((await b.filas('SELECT 1 FROM correos_directos WHERE idempotency_key = $1', [k]))).toHaveLength(1);
  });

  it('solo el admin de su estudio la lee; nadie la escribe por REST', async () => {
    await reg('ekko:email:stripe:evt_db:recibo', 'fallo', null, 'red', tenantB);
    const ver = (p: Persona) => b.como(p, () => b.filas<{ k: string }>('SELECT idempotency_key AS k FROM correos_directos'));
    expect((await ver(admin)).map((r) => r.k)).not.toContain('ekko:email:stripe:evt_db:recibo');
    expect((await ver(admin)).length).toBeGreaterThan(0);
    expect(await ver(recep)).toEqual([]);
    expect(await ver(m)).toEqual([]);
    await expect(b.como(admin, () => b.fila(`UPDATE correos_directos SET resultado = 'aceptado'`))).rejects.toThrow(/permission denied/);
  });
});

describe('eventos de Stripe: cierre humano', () => {
  const evento = (id: string, estado: string, cuenta: string, extra = '') =>
    b.db.query(`INSERT INTO stripe_webhook_events (id, type, estado, stripe_account, intentos, ultimo_intento_at, motivo ${extra ? ', lease_hasta' : ''})
                VALUES ($1, 'customer.subscription.updated', $2, $3, 1, now() - interval '1 hour', 'membresia_no_encontrada' ${extra ? ', ' + extra : ''})`, [id, estado, cuenta]);
  const resolver = (p: Persona, id: string, res = 'sin_efecto', nota = 'Revisado en el panel de Stripe') =>
    b.como(p, () => b.fila<{ r: { idempotente: boolean } }>('SELECT resolver_evento_stripe($1, $2, $3) AS r', [id, res, nota])).then((x) => x.r);

  beforeAll(async () => {
    await evento('evt_a_rev', 'revision', 'acct_a');
    await evento('evt_a_ok', 'procesado', 'acct_a');
    await evento('evt_b_rev', 'revision', 'acct_b');
  });

  it('el admin solo ve los eventos de SU cuenta conectada; staff y miembro no ven ninguno', async () => {
    const ids = (p: Persona) => b.como(p, () => b.filas<{ id: string }>('SELECT id FROM stripe_webhook_events')).then((r) => r.map((x) => x.id));
    expect(await ids(admin)).toEqual(expect.arrayContaining(['evt_a_rev', 'evt_a_ok']));
    expect(await ids(admin)).not.toContain('evt_b_rev');
    expect(await ids(adminB)).toEqual(['evt_b_rev']);
    expect(await ids(recep)).toEqual([]);
    expect(await ids(m)).toEqual([]);
  });

  it('resolver: admin, con nota, auditado, idempotente; la evidencia original no cambia', async () => {
    await expect(resolver(recep, 'evt_a_rev')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(resolver(m, 'evt_a_rev')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(resolver(admin, 'evt_a_rev', 'sin_efecto', 'corta')).rejects.toThrow(/EKKO_NOTA_REQUERIDA/);
    await expect(resolver(admin, 'evt_b_rev')).rejects.toThrow(/EKKO_EVENTO_INVALIDO/);
    await expect(resolver(admin, 'evt_a_ok')).rejects.toThrow(/EKKO_EVENTO_SIN_PENDIENTE/);

    expect(await resolver(admin, 'evt_a_rev')).toMatchObject({ idempotente: false });
    expect(await resolver(admin, 'evt_a_rev')).toMatchObject({ idempotente: true });
    await expect(resolver(admin, 'evt_a_rev', 'otro')).rejects.toThrow(/EKKO_EVENTO_RESUELTO/);

    const e = await b.fila<{ estado: string; motivo: string; intentos: number; resolucion: string; revisado_por: string }>(
      `SELECT estado, motivo, intentos, resolucion, revisado_por FROM stripe_webhook_events WHERE id = 'evt_a_rev'`);
    expect(e).toEqual({ estado: 'revision', motivo: 'membresia_no_encontrada', intentos: 1, resolucion: 'sin_efecto', revisado_por: admin.id });
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE accion = 'evento_stripe_resuelto' AND metadata->>'evento_id' = 'evt_a_rev'`))).toHaveLength(1);
    // Nadie lo escribe por REST.
    await expect(b.como(admin, () => b.fila(`UPDATE stripe_webhook_events SET estado = 'procesado' WHERE id = 'evt_a_rev'`))).rejects.toThrow(/permission denied/);
  });

  it('si Stripe lo reintenta después de resolverlo y vuelve a fallar, reaparece como pendiente', async () => {
    const enVista = async () => (await pendientes(admin)).some((r) => r.fuente_id === 'evt_a_rev');
    expect(await enVista()).toBe(false);
    await b.db.query(`UPDATE stripe_webhook_events SET intentos = 2, ultimo_intento_at = now() + interval '1 second' WHERE id = 'evt_a_rev'`);
    expect(await enVista()).toBe(true);
  });
});

describe('operaciones de cobro: tope y cierre humano', () => {
  let op: string;
  const fallar = () => b.fila<{ p: { ejecutar: boolean } }>('SELECT operacion_suscripcion_preparar($1) AS p', [op])
    .then(() => b.fila('SELECT operacion_suscripcion_resultado($1, false, $2, NULL)', [op, 'Stripe caído']));
  const estado = () => b.fila<{ estado: string; intentos: number; agotada: boolean; base: number; motivo_descarte: string | null }>(
    `SELECT estado, intentos, reintentos_agotados_at IS NOT NULL AS agotada, intentos_ronda_base AS base, motivo_descarte
     FROM stripe_operaciones_suscripcion WHERE id = $1`, [op]);
  const tomables = () => b.filas<{ id: string }>(
    `SELECT id FROM stripe_operaciones_suscripcion WHERE estado IN ('pendiente', 'fallida') AND reintentos_agotados_at IS NULL`).then((r) => r.map((x) => x.id));
  const avisos = (titulo: string) => b.fila<{ n: number }>(
    `SELECT count(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND tipo = 'stripe_revision' AND titulo = $2`, [admin.id, titulo]).then((x) => x.n);

  beforeAll(async () => {
    const mem = await b.fila<{ id: string }>(`SELECT id FROM membresias WHERE usuario_id = $1`, [m.id]);
    op = (await b.fila<{ id: string }>(
      `INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
       VALUES ($1, $2, $3, 'sub_03a_otra', 'cancelar_suscripcion', 'baja_inmediata', 'cancelar:03a-prueba') RETURNING id`,
      [b.tenantId, m.id, mem.id])).id;
  });

  it('5 fallos automáticos por ronda y se agota: el ejecutor ya no la toma; un aviso al fallar y otro al agotarse', async () => {
    for (let i = 0; i < 4; i++) await fallar();
    expect(await estado()).toMatchObject({ estado: 'fallida', intentos: 4, agotada: false });
    expect(await tomables()).toContain(op);
    await fallar();
    expect(await estado()).toMatchObject({ estado: 'fallida', intentos: 5, agotada: true });
    expect(await tomables()).not.toContain(op);
    expect(await avisos('Stripe no aplicó un cambio de cobro')).toBe(1);
    expect(await avisos('Un cambio de cobro necesita tu decisión')).toBe(1);
  });

  it('reintentar (admin, con nota): ronda nueva sobre la MISMA fila y la misma llave; idempotente; auditado', async () => {
    const reintentar = (p: Persona) => b.como(p, () => b.fila<{ r: { idempotente: boolean } }>(
      `SELECT staff_reintentar_operacion_cobro($1, 'Se corrigió la cuenta en Stripe') AS r`, [op])).then((x) => x.r);
    await expect(reintentar(recep)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(reintentar(adminB)).rejects.toThrow(/EKKO_OPERACION_INVALIDA/);
    expect(await reintentar(admin)).toMatchObject({ idempotente: false });
    expect(await reintentar(admin)).toMatchObject({ idempotente: true });
    expect(await estado()).toMatchObject({ estado: 'pendiente', agotada: false, base: 5 });
    expect(await tomables()).toContain(op);
    // Una falla más NO agota: es el intento 1 de la nueva ronda; la llave del proveedor sigue siendo por operación + intento.
    const p = await b.fila<{ p: { idempotency_key: string } }>('SELECT operacion_suscripcion_preparar($1) AS p', [op]);
    expect(p.p.idempotency_key).toBe('ekko:cancelar:03a-prueba:6');
    await b.fila('SELECT operacion_suscripcion_resultado($1, false, $2, NULL)', [op, 'otra vez']);
    expect(await estado()).toMatchObject({ estado: 'fallida', intentos: 6, agotada: false });
    expect((await b.filas(`SELECT 1 FROM stripe_operaciones_suscripcion WHERE operation_key = 'cancelar:03a-prueba'`))).toHaveLength(1);
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE accion = 'operacion_cobro_reintentada' AND target_id = $1`, [op]))).toHaveLength(1);
  });

  it('descartar (admin, con nota): queda escrito quién y por qué; idempotente; lo aplicado no se descarta', async () => {
    const descartar = (id: string) => b.como(admin, () => b.fila<{ r: { idempotente: boolean } }>(
      `SELECT staff_descartar_operacion_cobro($1, 'Se canceló a mano en el panel de Stripe') AS r`, [id])).then((x) => x.r);
    expect(await descartar(op)).toMatchObject({ idempotente: false });
    expect(await descartar(op)).toMatchObject({ idempotente: true });
    expect(await estado()).toMatchObject({ estado: 'descartada', motivo_descarte: 'descartada_por_admin' });
    const r = await b.fila<{ revisada_por: string; nota_revision: string }>('SELECT revisada_por, nota_revision FROM stripe_operaciones_suscripcion WHERE id = $1', [op]);
    expect(r).toEqual({ revisada_por: admin.id, nota_revision: 'Se canceló a mano en el panel de Stripe' });

    const aplicada = (await b.fila<{ id: string }>(
      `INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, stripe_subscription_id, tipo, causa, operation_key)
       VALUES ($1, $2, 'sub_x', 'cancelar_suscripcion', 'baja_inmediata', 'cancelar:03a-aplicada') RETURNING id`, [b.tenantId, m.id])).id;
    await b.fila('SELECT operacion_suscripcion_resultado($1, true, NULL, NULL)', [aplicada]);
    await expect(descartar(aplicada)).rejects.toThrow(/EKKO_OPERACION_CERRADA/);
  });
});

describe('v_pendientes_operativos', () => {
  beforeAll(async () => {
    await b.db.query(`INSERT INTO revisiones_financieras (tenant_id, tipo, referencia, detalle) VALUES ($1, 'credito_no_restaurado', 'res-03a', $2)`,
      [b.tenantId, JSON.stringify({ usuario_id: m.id })]);
    await b.db.query(`INSERT INTO revisiones_financieras (tenant_id, tipo, referencia) VALUES ($1, 'credito_no_restaurado', 'res-03a-b')`, [tenantB]);
    await b.db.query(`INSERT INTO stripe_webhook_events (id, type, estado, stripe_account) VALUES ('evt_v_a', 'invoice.paid', 'revision', 'acct_a'), ('evt_v_b', 'invoice.paid', 'revision', 'acct_b')`);
    const n = await aviso(m);
    await b.db.query(`UPDATE notificaciones SET email_resultado = 'fallo', email_ultimo_error = 'http_4xx:422', email_intentos = 1 WHERE id = $1`, [n]);
    await b.fila(`SELECT registrar_correo_directo('ekko:email:stripe:evt_v:recibo', $1, $2, 'recibo', 'evt_v', 'fallo', NULL, 'red')`, [b.tenantId, m.id]);
    // Un miembro activo sin membresía viva: divergencia de DERECHO (activo_sin_derecho).
    await b.crearPersona();
  });

  it('el admin ve cada dominio de SU estudio, derivado de su autoridad (sin copias)', async () => {
    const filas = await pendientes(admin);
    const fuentes = new Set(filas.map((f) => f.fuente));
    for (const f of ['revisiones_financieras', 'stripe_webhook_events', 'notificaciones', 'correos_directos', 'v_reconciliacion_membresia']) {
      expect(fuentes, f).toContain(f);
    }
    expect(filas.every((f) => f.tenant_id === b.tenantId)).toBe(true);
    expect(filas.map((f) => f.fuente_id)).toContain('evt_v_a');
    expect(filas.map((f) => f.fuente_id)).not.toContain('evt_v_b');
    // Cada fila de revisiones es exactamente una revisión abierta (no hay copia).
    const abiertas = await b.fila<{ n: number }>(`SELECT count(*)::int AS n FROM revisiones_financieras WHERE tenant_id = $1 AND estado = 'abierta'`, [b.tenantId]);
    expect(filas.filter((f) => f.fuente === 'revisiones_financieras')).toHaveLength(abiertas.n);
    // Una divergencia de caché de display no es trabajo (EKKO-123).
    expect(filas.some((f) => f.tipo === 'tier_distinto' || f.tipo === 'tier_sin_membresia_viva')).toBe(false);
  });

  it('el admin de otro estudio no ve nada de éste; recepción y miembro, nada; anon, permiso denegado', async () => {
    const deB = await pendientes(adminB);
    expect(deB.every((f) => f.tenant_id === tenantB)).toBe(true);
    expect(deB.map((f) => f.fuente_id)).toContain('evt_v_b');
    expect(await pendientes(recep)).toEqual([]);
    expect(await pendientes(m)).toEqual([]);
    await expect(comoAnon(() => b.filas('SELECT 1 FROM v_pendientes_operativos'))).rejects.toThrow(/permission denied/);
  });

  it('atender un fallo de entrega lo saca de la vista (leído ≠ resuelto: marcar leído no lo saca)', async () => {
    const fila = (await pendientes(admin)).find((f) => f.fuente === 'notificaciones')!;
    await b.como(m, () => b.fila(`UPDATE notificaciones SET leida = true WHERE id = $1`, [fila.fuente_id]));
    expect((await pendientes(admin)).some((f) => f.fuente_id === fila.fuente_id)).toBe(true);
    await expect(b.como(recep, () => b.fila(`SELECT resolver_fallo_entrega('notificaciones', $1, 'Se le avisó por WhatsApp')`, [fila.fuente_id]))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await b.como(admin, () => b.fila(`SELECT resolver_fallo_entrega('notificaciones', $1, 'Se le avisó por WhatsApp')`, [fila.fuente_id]));
    await b.como(admin, () => b.fila(`SELECT resolver_fallo_entrega('correos_directos', 'ekko:email:stripe:evt_v:recibo', 'Recibo reenviado a mano')`));
    const despues = await pendientes(admin);
    expect(despues.some((f) => f.fuente_id === fila.fuente_id)).toBe(false);
    expect(despues.some((f) => f.fuente_id === 'ekko:email:stripe:evt_v:recibo')).toBe(false);
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE accion = 'fallo_entrega_atendido'`))).toHaveLength(2);
  });
});

describe('autorización de los objetos nuevos', () => {
  it('ninguna función nueva es ejecutable por anon ni PUBLIC; las de servicio no las ejecuta authenticated', async () => {
    const r = await b.filas<{ f: string; anon: boolean; publico: boolean; auth: boolean }>(
      `SELECT p.proname AS f, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS publico,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
       FROM pg_proc p WHERE p.proname IN ('reclamar_correos_pendientes', 'notificacion_email_resultado', 'reclamar_push_pendientes',
         'registrar_resultado_push', 'registrar_correo_directo', 'resolver_fallo_entrega', 'resolver_evento_stripe',
         'staff_reintentar_operacion_cobro', 'staff_descartar_operacion_cobro', '_mi_cuenta_stripe') ORDER BY 1`);
    expect(r).toHaveLength(10);
    for (const x of r) {
      expect(x.anon, x.f).toBe(false);
      expect(x.publico, x.f).toBe(false);
    }
    const deServicio = ['reclamar_correos_pendientes', 'notificacion_email_resultado', 'reclamar_push_pendientes', 'registrar_resultado_push', 'registrar_correo_directo'];
    for (const x of r) expect(x.auth, x.f).toBe(!deServicio.includes(x.f));
  });

  it('el miembro no puede llamar las RPC de servicio', async () => {
    await expect(b.como(m, () => b.filas(`SELECT * FROM reclamar_push_pendientes(10)`))).rejects.toThrow(/permission denied/);
  });
});
