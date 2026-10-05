// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * R2-B · PKG-01O + 01P + 01Q · migración 20261005110000 contra Postgres real.
 *
 *  01Q  La cancelación sabe QUIÉN la causó. Miembro tarde → crédito consumido.
 *       Estudio → crédito devuelto si hay destino. Ventana con UNA fuente.
 *       Reserva cancelada con extras pagados → UNA revisión, sin reembolso.
 *  01O  Crédito sin destino → evidencia + UNA revisión (nunca pérdida silenciosa
 *       ni membresía resucitada). No se reserva después del fin efectivo del
 *       derecho. Sin penalización por una falta que EKKO hizo imposible.
 *  01P  Sanción → operación durable "suspender cobro"; levantar → "reanudar" solo
 *       si todo sigue válido. Revocación → "cancelar suscripción" inmediata. Si
 *       el proveedor falla, EKKO no se deshace y la operación queda reintentable.
 *
 * Las llamadas a Stripe NO ocurren aquí: se prueba la máquina de estados durable
 * (preparar → resultado). El ejecutor se prueba con Stripe simulado en
 * src/__tests__/operacionesSuscripcion.test.ts.
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
const CUENTA = 'acct_ekko_r2b';
type Json = Record<string, unknown>;
const id8 = () => randomUUID().slice(0, 8);

const reserva = (id: string) =>
  b.fila<{ status: string; cancelacion_causa: string | null; cancelacion_tardia: boolean | null; cancelada_por: string | null;
    invitados_extra_pagados: number }>('SELECT * FROM reservas WHERE id = $1', [id]);
const movs = (reservaId: string) =>
  b.filas<{ tipo: string; delta: number }>('SELECT tipo, delta FROM membresia_movimientos WHERE reserva_id = $1 ORDER BY created_at, tipo', [reservaId]);
const revisiones = (reservaId: string, tipo?: string) =>
  b.filas<{ tipo: string; estado: string; detalle: Json }>(
    `SELECT tipo, estado, detalle FROM revisiones_financieras WHERE referencia = $1 AND ($2::text IS NULL OR tipo = $2) ORDER BY created_at`,
    [reservaId, tipo ?? null]);
const avisos = (p: Persona, tipo?: string) =>
  b.filas<{ tipo: string; titulo: string; mensaje: string; metadata: Json }>(
    'SELECT tipo, titulo, mensaje, metadata FROM notificaciones WHERE usuario_id = $1 AND ($2::text IS NULL OR tipo = $2) ORDER BY creada_at', [p.id, tipo ?? null]);
const ops = (p: Persona) =>
  b.filas<{ id: string; tipo: string; causa: string; estado: string; operation_key: string; intentos: number; motivo_descarte: string | null; ultimo_error: string | null }>(
    'SELECT * FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 ORDER BY created_at, tipo', [p.id]);
const usuario = (p: Persona) =>
  b.fila<{ status: string; sancionado_at: string | null; no_shows_count: number; bloqueado_hasta: string | null }>(
    'SELECT status, sancionado_at, no_shows_count, bloqueado_hasta FROM usuarios WHERE id = $1', [p.id]);

async function reservarRecep(m: Persona, recurso: string, dias: number, hora: number, invitados = 0): Promise<string> {
  const slot = await b.slot(dias, hora);
  const x = await b.como(recep, () =>
    b.fila<{ r: { reserva_id: string } }>('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, $4, NULL) AS r', [m.id, recurso, slot, invitados]));
  return x.r.reserva_id;
}
/** Deja la sesión a `horas` de empezar (dentro o fuera de la ventana de 24 h). */
const aHoras = (id: string, horas: number) =>
  b.db.query(`UPDATE reservas SET slot_inicio = now() + make_interval(hours => $2), slot_fin = now() + make_interval(hours => $2 + 1) WHERE id = $1`, [id, horas]);
const alPasado = (id: string) =>
  b.db.query(`UPDATE reservas SET slot_inicio = now() - interval '4 hours', slot_fin = now() - interval '3 hours' WHERE id = $1`, [id]);

const cancelar = (actor: Persona, id: string, causa?: 'miembro' | 'estudio' | null, motivo = 'Motivo de prueba') =>
  b.como(actor, () => (causa === undefined
    ? b.fila('SELECT cancelar_reserva_atomic($1, $2)', [id, motivo])
    : b.fila('SELECT cancelar_reserva_atomic($1, $2, $3)', [id, motivo, causa])));

async function aplicarExtra(reservaId: string, m: Persona, cantidad = 1) {
  const r = await b.fila<{ r: { estado: string } }>(
    `SELECT aplicar_invitados_extra_pago($1, $2, $3, $4, $5, $6, $7, $8, 10000, 'mxn', now(), NULL) AS r`,
    [`pi_${id8()}`, CUENTA, b.tenantId, `evt_${id8()}`, reservaId, m.id, cantidad, cantidad * 10000]);
  expect(r.r.estado).toBe('aplicado');
}

/** Miembro con suscripción de Stripe viva (como la deja el webhook). */
async function conSuscripcion(slug = 'premium'): Promise<{ m: Persona; sub: string; mem: string }> {
  const m = await b.crearPersona();
  const sub = `sub_${id8()}`;
  await b.activar(m, slug, { id: sub, fin: '2099-01-01' });
  const mem = await b.fila<{ id: string }>('SELECT id FROM membresias WHERE stripe_subscription_id = $1', [sub]);
  return { m, sub, mem: mem.id };
}
const sancionar = (m: Persona) =>
  b.db.query(`UPDATE usuarios SET status = 'suspendido', sancionado_at = now(), sancion_motivo = 'Daños al equipo' WHERE id = $1`, [m.id]);
const levantar = (m: Persona) =>
  b.db.query(`UPDATE usuarios SET status = 'activo', sancionado_at = NULL, sancion_motivo = NULL WHERE id = $1`, [m.id]);
const preparar = (id: string) => b.fila<{ r: Json }>('SELECT operacion_suscripcion_preparar($1) AS r', [id]).then((x) => x.r);
const resultado = (id: string, ok: boolean, error: string | null = null) =>
  b.fila<{ r: Json }>('SELECT operacion_suscripcion_resultado($1, $2, $3, $4::jsonb) AS r', [id, ok, error, JSON.stringify(ok ? { status: 'active' } : {})]).then((x) => x.r);
const sync = (sub: string, estado: string) =>
  b.fila<{ r: Json }>('SELECT sync_membresia_stripe($1, $2, NULL, NULL, now()) AS r', [sub, estado]).then((x) => x.r);

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  await b.db.query(`UPDATE tenants SET stripe_account_id = $2,
    config = jsonb_set(jsonb_set(config, '{reserva,max_sesiones_por_dia}', '20'), '{reserva,permitir_continuas}', 'true') WHERE id = $1`,
    [b.tenantId, CUENTA]);
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

// ════════════════════════════════════════════════════════════════════════════
describe('01Q · ventana de cancelación: una sola fuente y frontera definida', () => {
  it('config del estudio; sin la clave → 24; 0 explícito se respeta; basura → 24', async () => {
    const horas = async (cfg: string) => {
      const t = await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, config) VALUES ($1, $1, $2::jsonb) RETURNING id`, [`t-${id8()}`, cfg]);
      return Number((await b.fila<{ h: string }>('SELECT _cancelacion_min_horas($1) AS h', [t.id])).h);
    };
    expect(await horas('{"reserva": {"cancelacion_min_horas_antes": 12}}')).toBe(12);
    expect(await horas('{"reserva": {"cancelacion_min_horas_antes": 0}}')).toBe(0);
    expect(await horas('{"reserva": {}}')).toBe(24);
    expect(await horas('{}')).toBe(24);
    expect(await horas('{"reserva": {"cancelacion_min_horas_antes": "pronto"}}')).toBe(24);
    expect(Number((await b.fila<{ h: string }>('SELECT _cancelacion_min_horas($1) AS h', [b.tenantId])).h)).toBe(24);
  });

  it('frontera: faltan MÁS de 24 h = a tiempo; exactamente 24 h o menos = tarde', async () => {
    const tardia = (expr: string) =>
      b.fila<{ t: boolean }>(`SELECT _cancelacion_tardia($1, now() + interval '${expr}') AS t`, [b.tenantId]).then((x) => x.t);
    expect(await tardia('24 hours 1 second')).toBe(false);
    expect(await tardia('24 hours')).toBe(true);
    expect(await tardia('2 hours')).toBe(true);
  });

  it('todas las funciones leen la misma fuente (sin defaults propios)', async () => {
    for (const fn of ['cancelar_reserva_atomic', 'reservar_recurso_atomic', 'creditos_devolver_al_cancelar', 'reservas_normalizar_cancelacion']) {
      const d = (await b.fila<{ d: string }>(`SELECT pg_get_functiondef($1::regproc) AS d`, [fn])).d;
      expect(d, fn).not.toMatch(/cancelacion_min_horas_antes/);
    }
    const priv = async (rol: string) =>
      (await b.fila<{ p: boolean }>(`SELECT has_function_privilege($1, 'cancelar_reserva_atomic(uuid, text, text)', 'EXECUTE') AS p`, [rol])).p;
    expect(await priv('authenticated')).toBe(true);
    expect(await priv('anon')).toBe(false);
    expect((await b.filas(`SELECT 1 FROM pg_proc WHERE proname = 'cancelar_reserva_atomic'`)).length).toBe(1);
  });
});

describe('01Q · quién causó la cancelación decide el crédito', () => {
  it('miembro, a tiempo: cancelada / causa miembro / crédito devuelto', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    expect(await b.creditos(m)).toBe(2);
    await cancelar(m, id);
    expect(await reserva(id)).toMatchObject({ status: 'cancelada', cancelacion_causa: 'miembro', cancelacion_tardia: false });
    expect(await b.creditos(m)).toBe(3);
    expect((await movs(id)).map((x) => x.tipo)).toEqual(['debito', 'devolucion']);
  });

  it('miembro, tarde: no puede cancelar por su cuenta; la reserva y el crédito quedan igual', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    await aHoras(id, 5);
    await expect(cancelar(m, id)).rejects.toThrow(/EKKO_CANCELACION_TARDIA/);
    expect((await reserva(id)).status).toBe('confirmada');
    expect(await b.creditos(m)).toBe(2);
  });

  it('recepción debe decir la causa: sin causa o con una inválida → EKKO_CAUSA_REQUERIDA', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    await expect(cancelar(recep, id)).rejects.toThrow(/EKKO_CAUSA_REQUERIDA/);
    await expect(cancelar(recep, id, null)).rejects.toThrow(/EKKO_CAUSA_REQUERIDA/);
    await expect(b.como(recep, () => b.fila(`SELECT cancelar_reserva_atomic($1, 'x', 'sistema')`, [id]))).rejects.toThrow(/EKKO_CAUSA_REQUERIDA/);
    expect((await reserva(id)).status).toBe('confirmada');
  });

  it('a petición del miembro, TARDE (por recepción): se cancela, el crédito NO vuelve, el aviso lo dice y queda auditado; reintento sin efectos', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    await aHoras(id, 5);
    await cancelar(recep, id, 'miembro', 'Avisó por WhatsApp');
    expect(await reserva(id)).toMatchObject({ status: 'cancelada', cancelacion_causa: 'miembro', cancelacion_tardia: true, cancelada_por: recep.id });
    expect(await b.creditos(m)).toBe(2);
    expect((await movs(id)).map((x) => x.tipo)).toEqual(['debito']);

    const av = await avisos(m);
    expect(av.some((a) => a.tipo === 'reserva_cancelada_por_ti')).toBe(false);
    const aviso = av.find((a) => a.tipo === 'reserva_cancelada')!;
    expect(aviso.titulo).toBe('Cancelamos tu reserva a tu solicitud');
    expect(aviso.mensaje).toMatch(/el crédito de esa sesión no se devuelve/);
    expect(aviso.metadata).toMatchObject({ causa: 'miembro', tardia: true });

    const audit = await b.filas<{ accion: string; actor_usuario_id: string; despues: Json; motivo: string }>(
      `SELECT accion, actor_usuario_id, despues, motivo FROM audit_log WHERE target_id = $1 AND accion LIKE 'reserva_cancelada%'`, [m.id]);
    expect(audit).toEqual([expect.objectContaining({
      accion: 'reserva_cancelada_a_peticion_del_miembro', actor_usuario_id: recep.id, motivo: 'Avisó por WhatsApp',
      despues: expect.objectContaining({ causa: 'miembro', tardia: true, credito_devuelto: false })
    })]);
    expect(await revisiones(id)).toEqual([]);

    // Reintento: ya no está confirmada → rechazo; sin segundo aviso, sin movimiento.
    await expect(cancelar(recep, id, 'miembro')).rejects.toThrow(/EKKO_RESERVA_NO_CANCELABLE/);
    await expect(cancelar(recep, id, 'estudio')).rejects.toThrow(/EKKO_RESERVA_NO_CANCELABLE/);
    expect(await b.creditos(m)).toBe(2);
    expect((await avisos(m, 'reserva_cancelada')).length).toBe(1);
  });

  it('a petición del miembro, A TIEMPO (por recepción): el crédito vuelve y el aviso lo dice', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    await cancelar(recep, id, 'miembro');
    expect(await reserva(id)).toMatchObject({ status: 'cancelada', cancelacion_causa: 'miembro', cancelacion_tardia: false });
    expect(await b.creditos(m)).toBe(3);
    expect((await avisos(m, 'reserva_cancelada'))[0].mensaje).toMatch(/Tu crédito fue devuelto/);
  });

  it('la cancela el ESTUDIO, aunque sea tarde: cancelada_admin, crédito devuelto UNA vez, bitácora del estudio', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    await aHoras(id, 2);
    await cancelar(recep, id, 'estudio', 'Falla eléctrica');
    expect(await reserva(id)).toMatchObject({ status: 'cancelada_admin', cancelacion_causa: 'estudio', cancelacion_tardia: false, cancelada_por: recep.id });
    expect(await b.creditos(m)).toBe(3);
    expect((await movs(id)).map((x) => [x.tipo, x.delta])).toEqual([['debito', -1], ['devolucion', 1]]);
    expect((await avisos(m, 'reserva_cancelada'))[0].mensaje).toMatch(/cancelada por el estudio\. Motivo: Falla eléctrica\. Tu crédito fue devuelto\./);
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE target_id = $1 AND accion = 'reserva_cancelada_por_estudio'`, [m.id])).length).toBe(1);
    await expect(cancelar(recep, id, 'estudio')).rejects.toThrow(/EKKO_RESERVA_NO_CANCELABLE/);
    expect(await b.creditos(m)).toBe(3);
  });

  it('plan mensual: no hay créditos por sesión → ninguna cancelación fabrica un movimiento', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const tarde = await reservarRecep(m, e, 3, 9);
    await aHoras(tarde, 3);
    await cancelar(recep, tarde, 'miembro');
    const estudio = await reservarRecep(m, e, 4, 9);
    await cancelar(recep, estudio, 'estudio');
    expect(await movs(tarde)).toEqual([]);
    expect(await movs(estudio)).toEqual([]);
    expect(await revisiones(tarde)).toEqual([]);
    expect(await revisiones(estudio)).toEqual([]);
    const av = await avisos(m, 'reserva_cancelada');
    expect(av.every((a) => !/crédito/.test(a.mensaje))).toBe(true);
    expect(av[0].mensaje).toMatch(/cuenta como usada en tu día/);
  });

  it('cualquier camino de servidor asienta la causa: reprogramar y UPDATE directo (estudio fuera de servicio) = estudio', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const e = await b.crearEstudio();
    const v = await reservarRecep(m, e, 3, 9);
    const slot = await b.slot(5, 9);
    await b.como(recep, () => b.fila('SELECT reprogramar_reserva($1, $2, $3::timestamptz, NULL, NULL, NULL)', [v, e, slot]));
    expect(await reserva(v)).toMatchObject({ status: 'cancelada_admin', cancelacion_causa: 'estudio' });
    expect(await b.creditos(m)).toBe(2); // neto cero (R2-A)
    const d = await reservarRecep(m, e, 6, 9);
    await b.db.query(`UPDATE reservas SET status = 'cancelada_admin', cancelada_motivo = 'Estudio fuera de servicio' WHERE id = $1`, [d]);
    expect(await reserva(d)).toMatchObject({ cancelacion_causa: 'estudio', cancelacion_tardia: false });
    // La causa no puede contradecir al estado.
    await expect(b.db.query(`UPDATE reservas SET cancelacion_causa = 'miembro' WHERE id = $1`, [d])).rejects.toThrow(/reservas_cancelacion_causa_check/);
  });
});

describe('01Q · invitados extra pagados en una reserva cancelada', () => {
  it('con extras: UNA revisión, sin reembolso y sin tocar la evidencia; sin extras: ninguna; reprogramar: ninguna', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const con = await reservarRecep(m, e, 3, 9, 1);
    await aplicarExtra(con, m, 2);
    const antes = await b.fila<{ h: string }>(`SELECT md5(string_agg(p::text, '' ORDER BY id)) AS h FROM invitados_extra_pagos p WHERE reserva_id = $1`, [con]);
    await cancelar(recep, con, 'estudio');
    const rev = await revisiones(con, 'extras_pagados_reserva_cancelada');
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ estado: 'abierta', detalle: { reserva_id: con, usuario_id: m.id, cantidad: 2, monto_centavos: 20000, causa_cancelacion: 'estudio', reembolso_automatico: false } });
    expect((rev[0].detalle.pagos as unknown[]).length).toBe(1);
    expect((await b.fila<{ h: string }>(`SELECT md5(string_agg(p::text, '' ORDER BY id)) AS h FROM invitados_extra_pagos p WHERE reserva_id = $1`, [con])).h).toBe(antes.h);
    expect((await reserva(con)).invitados_extra_pagados).toBe(2);
    expect((await b.filas('SELECT 1 FROM reversales_pago')).length).toBe(0);
    expect((await avisos(admin, 'revision_financiera')).some((a) => a.metadata.reserva_id === con && a.metadata.tipo === 'extras_pagados_reserva_cancelada')).toBe(true);

    // Reintento del disparo: la revisión no se duplica (ni resuelta).
    await b.db.query(`UPDATE revisiones_financieras SET estado = 'resuelta', resolucion = 'sin_efecto', resuelta_at = now() WHERE referencia = $1`, [con]);
    const creada = await b.fila<{ c: boolean }>(
      `SELECT _abrir_revision_reserva($1, 'extras_pagados_reserva_cancelada', $2, '{}'::jsonb, 't', 'm') AS c`, [b.tenantId, con]);
    expect(creada.c).toBe(false);
    expect((await revisiones(con)).length).toBe(1);

    const sin = await reservarRecep(m, e, 4, 9, 1);
    await cancelar(recep, sin, 'estudio');
    expect(await revisiones(sin)).toEqual([]);

    // Reprogramar traslada los extras: la reserva vieja ya no los tiene → sin revisión.
    const vieja = await reservarRecep(m, e, 5, 9, 0);
    await aplicarExtra(vieja, m, 1);
    const slot = await b.slot(7, 9);
    await b.como(recep, () => b.fila('SELECT reprogramar_reserva($1, $2, $3::timestamptz, NULL, NULL, NULL)', [vieja, e, slot]));
    expect(await revisiones(vieja)).toEqual([]);
  });

  it('también cuando la cancela el miembro: la revisión avisa al estudio (el reembolso sigue siendo manual)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 3, 9);
    await aplicarExtra(id, m, 1);
    await cancelar(m, id);
    expect((await revisiones(id, 'extras_pagados_reserva_cancelada'))[0].detalle).toMatchObject({ causa_cancelacion: 'miembro', cantidad: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('01O · crédito que no se puede restaurar: evidencia + una revisión', () => {
  it('membresía dada de baja y el estudio cancela la reserva futura: sin pérdida silenciosa, sin resurrección, UNA revisión', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const e = await b.crearEstudio();
    const id = await reservarRecep(m, e, 3, 9);
    const mem = await b.fila<{ id: string }>('SELECT id FROM membresias WHERE usuario_id = $1', [m.id]);
    await b.como(recep, () => b.fila('SELECT staff_cancelar_membresia($1, true, $2)', [m.id, 'Se muda de ciudad']));
    // EKKO-057 se conserva: la baja NO cancela la reserva futura.
    expect((await reserva(id)).status).toBe('confirmada');
    const ledgerAntes = await b.filas('SELECT id, tipo, delta, saldo_after FROM membresia_movimientos WHERE usuario_id = $1 ORDER BY created_at, id', [m.id]);

    await cancelar(recep, id, 'estudio', 'Mantenimiento');
    expect((await movs(id)).map((x) => x.tipo)).toEqual(['debito']);
    const rev = await revisiones(id, 'credito_no_restaurado');
    expect(rev).toHaveLength(1);
    expect(rev[0].detalle).toMatchObject({
      reserva_id: id, usuario_id: m.id, membresia_id: mem.id, membresia_status: 'cancelada', creditos: 1,
      causa_cancelacion: 'estudio', razon: 'derecho_terminado', efecto_automatico: 'ninguno'
    });
    expect(rev[0].detalle.movimiento_debito_id).toBeTruthy();
    // Nada se fabricó ni se reescribió.
    expect(await b.filas('SELECT id, tipo, delta, saldo_after FROM membresia_movimientos WHERE usuario_id = $1 ORDER BY created_at, id', [m.id])).toEqual(ledgerAntes);
    expect(await b.filas('SELECT status FROM membresias WHERE usuario_id = $1', [m.id])).toEqual([{ status: 'cancelada' }]);
    expect((await avisos(m, 'reserva_cancelada'))[0].mensaje).toMatch(/no pudo devolverse automáticamente; el estudio lo revisará contigo/);
    expect((await avisos(admin, 'revision_financiera')).some((a) => a.metadata.reserva_id === id && a.metadata.tipo === 'credito_no_restaurado')).toBe(true);
    // Resolver sigue siendo humano y no muta nada.
    const revId = await b.fila<{ id: string }>(`SELECT id FROM revisiones_financieras WHERE referencia = $1`, [id]);
    await b.como(admin, () => b.fila(`SELECT resolver_revision_financiera($1, 'sin_efecto', 'Se le explicó al miembro; sin devolución')`, [revId.id]));
    expect(await b.filas('SELECT status FROM membresias WHERE usuario_id = $1', [m.id])).toEqual([{ status: 'cancelada' }]);
  });

  it('si hay otra membresía viva con créditos, ahí vuelve (sin revisión); si la viva es mensual, no hay destino → revisión', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const e = await b.crearEstudio();
    const r1 = await reservarRecep(m, e, 3, 9);
    const r2 = await reservarRecep(m, e, 4, 9);
    await b.db.query(`UPDATE membresias SET status = 'cancelada', cancelada_at = now() WHERE usuario_id = $1`, [m.id]);
    await b.activar(m, 'creador'); // paquete nuevo: 6 créditos
    await cancelar(recep, r1, 'estudio');
    expect(await b.creditos(m)).toBe(7);
    expect(await revisiones(r1)).toEqual([]);

    await b.db.query(`UPDATE membresias SET status = 'cancelada', cancelada_at = now() WHERE usuario_id = $1 AND status = 'activa'`, [m.id]);
    await b.activar(m, 'premium'); // mensual: no maneja créditos
    await cancelar(recep, r2, 'estudio');
    expect((await revisiones(r2, 'credito_no_restaurado'))[0].detalle).toMatchObject({ razon: 'membresia_viva_sin_creditos' });
    expect(await b.creditos(m)).toBeNull();
  });
});

describe('01O · no se reserva después del fin efectivo del derecho', () => {
  it('baja programada al fin del periodo: antes del fin sí; después → EKKO_FUERA_DE_VIGENCIA (miembro y recepción)', async () => {
    const { m, sub } = await conSuscripcion('premium');
    await b.db.query(`UPDATE membresias SET cancel_at_period_end = true, periodo_actual_fin = now() + interval '10 days' WHERE stripe_subscription_id = $1`, [sub]);
    const e = await b.crearEstudio();
    const dentro = await b.slot(5, 9);
    const fuera = await b.slot(12, 9);
    expect((await b.reservar(m, e, dentro)).success).toBe(true);
    await expect(b.reservar(m, e, fuera)).rejects.toThrow(/EKKO_FUERA_DE_VIGENCIA/);
    await expect(b.como(recep, () => b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, 0, NULL)', [m.id, e, fuera])))
      .rejects.toThrow(/EKKO_FUERA_DE_VIGENCIA/);
    expect((await b.filas('SELECT 1 FROM reservas WHERE usuario_id = $1', [m.id])).length).toBe(1);
  });

  it('suscripción que se renueva: sin fin conocido → puede reservar más allá del periodo actual', async () => {
    const { m, sub } = await conSuscripcion('premium');
    await b.db.query(`UPDATE membresias SET periodo_actual_fin = now() + interval '10 days' WHERE stripe_subscription_id = $1`, [sub]);
    expect((await b.reservar(m, await b.crearEstudio(), await b.slot(12, 9))).success).toBe(true);
  });

  it('mensual de mostrador (no se renueva sola): no reserva después de su vencimiento; reprogramar tampoco', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    await b.db.query(`UPDATE membresias SET periodo_actual_fin = now() + interval '10 days' WHERE usuario_id = $1`, [m.id]);
    const e = await b.crearEstudio();
    const fuera = await b.slot(12, 9);
    await expect(b.reservar(m, e, fuera)).rejects.toThrow(/EKKO_FUERA_DE_VIGENCIA/);
    const id = await reservarRecep(m, e, 5, 9);
    await expect(b.como(recep, () => b.fila('SELECT reprogramar_reserva($1, $2, $3::timestamptz, NULL, NULL, NULL)', [id, e, fuera])))
      .rejects.toThrow(/EKKO_FUERA_DE_VIGENCIA/);
    expect((await reserva(id)).status).toBe('confirmada');
  });

  it('paquete de créditos: la sesión queda pagada al reservar (la puerta la deja pasar) → no se bloquea', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    await b.db.query(`UPDATE membresias SET periodo_actual_fin = now() + interval '10 days' WHERE usuario_id = $1`, [m.id]);
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(12, 9));
    expect(r.success).toBe(true);
    expect((await b.fila<{ e: string }>('SELECT _estado_membresia_checkin($1, $2) AS e', [m.id, r.reserva_id])).e).toBe('ok');
  });
});

describe('01O · sin penalización por una falta que EKKO hizo imposible', () => {
  it('baja de la membresía (mensual): la reserva futura sigue; al pasar queda no_show SIN contador, bloqueo ni aviso', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 2, 9);
    await b.como(recep, () => b.fila('SELECT staff_cancelar_membresia($1, true, $2)', [m.id, 'Baja solicitada']));
    expect((await reserva(id)).status).toBe('confirmada');
    await b.db.query('UPDATE usuarios SET no_shows_count = 2 WHERE id = $1', [m.id]);
    await alPasado(id);
    await b.fila('SELECT marcar_no_shows()');
    expect((await reserva(id)).status).toBe('no_show');
    expect(await usuario(m)).toMatchObject({ no_shows_count: 2, bloqueado_hasta: null });
    expect(await avisos(m, 'no_show')).toEqual([]);
    const audit = await b.filas<{ accion: string; despues: Json }>(`SELECT accion, despues FROM audit_log WHERE target_id = $1 AND accion LIKE 'no_show%'`, [m.id]);
    expect(audit).toEqual([{ accion: 'no_show_sin_penalizacion', despues: expect.objectContaining({ reserva_status: 'no_show' }) }]);
  });

  it('cuenta sancionada o revocada: tampoco se penaliza', async () => {
    for (const set of [`status = 'suspendido', sancionado_at = now()`, `status = 'revocado'`]) {
      const m = await b.crearPersona();
      await b.activar(m, 'premium');
      const id = await reservarRecep(m, await b.crearEstudio(), 2, 9);
      await b.db.query(`UPDATE usuarios SET ${set} WHERE id = $1`, [m.id]);
      await alPasado(id);
      await b.fila('SELECT marcar_no_shows()');
      expect((await reserva(id)).status, set).toBe('no_show');
      expect((await usuario(m)).no_shows_count, set).toBe(0);
    }
  });

  it('sesión pagada con créditos (podía entrar) o miembro vigente: la falta se penaliza como siempre', async () => {
    const paquete = await b.crearPersona();
    await b.activar(paquete, 'starter');
    const e = await b.crearEstudio();
    const r1 = await reservarRecep(paquete, e, 2, 9);
    await b.db.query(`UPDATE membresias SET status = 'expirada' WHERE usuario_id = $1`, [paquete.id]);
    const vigente = await b.crearPersona();
    await b.activar(vigente, 'premium');
    const r2 = await reservarRecep(vigente, await b.crearEstudio(), 2, 11);
    await alPasado(r1);
    await alPasado(r2);
    await b.fila('SELECT marcar_no_shows()');
    expect((await usuario(paquete)).no_shows_count).toBe(1);
    expect((await usuario(vigente)).no_shows_count).toBe(1);
    expect((await avisos(vigente, 'no_show')).length).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('01P · sanción: el cobro se suspende (reversible) con evidencia durable', () => {
  it('sancionar crea UNA operación "suspender"; el fallo del proveedor no deshace la sanción; el reintento es la misma operación', async () => {
    const { m, sub, mem } = await conSuscripcion();
    await sancionar(m);
    let o = await ops(m);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ tipo: 'suspender_cobro', causa: 'sancion', estado: 'pendiente', intentos: 0 });
    expect(o[0].operation_key).toMatch(new RegExp(`^suspender:${mem}:\\d+$`));
    expect(await usuario(m)).toMatchObject({ status: 'suspendido' });

    // "Reintento" de la sanción (mismo estado, otro UPDATE): no hay segunda operación.
    await b.db.query(`UPDATE usuarios SET sancionado_at = now() + interval '1 second', status = 'suspendido' WHERE id = $1`, [m.id]);
    expect(await ops(m)).toHaveLength(1);

    const p1 = await preparar(o[0].id);
    expect(p1).toMatchObject({ ejecutar: true, tipo: 'suspender_cobro', stripe_subscription_id: sub, intento: 1, idempotency_key: `ekko:${o[0].operation_key}:1` });
    expect(await resultado(o[0].id, false, 'api_connection_error:timeout')).toMatchObject({ estado: 'fallida' });
    o = await ops(m);
    expect(o[0]).toMatchObject({ estado: 'fallida', intentos: 1, ultimo_error: 'api_connection_error:timeout' });
    // La sanción sigue vigente y el admin quedó avisado (una vez).
    expect((await usuario(m)).sancionado_at).not.toBeNull();
    expect((await avisos(admin, 'stripe_revision')).filter((a) => a.metadata.operacion_id === o[0].id)).toHaveLength(1);

    const p2 = await preparar(o[0].id);
    expect(p2).toMatchObject({ ejecutar: true, intento: 2, idempotency_key: `ekko:${o[0].operation_key}:2` });
    expect(await resultado(o[0].id, true)).toMatchObject({ estado: 'aplicada', idempotente: false });
    // Resultado repetido / preparar otra vez: sin efectos nuevos.
    expect(await resultado(o[0].id, true)).toMatchObject({ estado: 'aplicada', idempotente: true });
    expect(await preparar(o[0].id)).toMatchObject({ ejecutar: false, estado: 'aplicada' });
    expect(await ops(m)).toHaveLength(1);
    expect((await avisos(admin, 'stripe_revision')).filter((a) => a.metadata.operacion_id === o[0].id)).toHaveLength(1);
  });

  it('sin suscripción de Stripe (mostrador / paquete) o ya en pausa: sancionar no crea operación', async () => {
    const mostrador = await b.crearPersona();
    await b.activar(mostrador, 'premium');
    await sancionar(mostrador);
    expect(await ops(mostrador)).toEqual([]);
    const { m, sub } = await conSuscripcion();
    await sync(sub, 'pausada');
    await sancionar(m);
    expect(await ops(m)).toEqual([]);
  });

  it('levantar la sanción reanuda SOLO si se había suspendido y todo sigue válido; repetirlo no crea otra', async () => {
    const { m } = await conSuscripcion();
    await sancionar(m);
    const s = (await ops(m))[0];
    await preparar(s.id);
    await resultado(s.id, true);
    await levantar(m);
    let o = await ops(m);
    expect(o.map((x) => [x.tipo, x.estado])).toEqual([['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'pendiente']]);
    expect(o[1]).toMatchObject({ causa: 'levantar_sancion', operation_key: `reanudar:${s.id}` });
    expect(await preparar(o[1].id)).toMatchObject({ ejecutar: true, tipo: 'reanudar_cobro' });
    await resultado(o[1].id, true);
    await b.db.query(`UPDATE usuarios SET status = 'activo' WHERE id = $1`, [m.id]);
    await b.fila('SELECT _reconciliar_cobro_sancion($1)', [m.id]);
    o = await ops(m);
    expect(o.map((x) => [x.tipo, x.estado])).toEqual([['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'aplicada']]);

    // Segunda sanción: nueva suspensión (otra identidad), y su propia reanudación.
    await sancionar(m);
    expect((await ops(m)).filter((x) => x.tipo === 'suspender_cobro')).toHaveLength(2);
  });

  it('sanción levantada antes de que Stripe la aplicara: la suspensión se descarta y no hay nada que reanudar', async () => {
    const { m } = await conSuscripcion();
    await sancionar(m);
    await levantar(m);
    const o = await ops(m);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ tipo: 'suspender_cobro', estado: 'descartada', motivo_descarte: 'sancion_levantada' });
    expect(await preparar(o[0].id)).toMatchObject({ ejecutar: false });
  });

  it('carrera: la suspensión ya iba en vuelo cuando se levantó la sanción → queda aplicada y se encadena la reanudación', async () => {
    const { m } = await conSuscripcion();
    await sancionar(m);
    const s = (await ops(m))[0];
    expect((await preparar(s.id)).ejecutar).toBe(true); // el ejecutor ya llamó a Stripe
    await levantar(m);                                   // mientras tanto se levanta
    await resultado(s.id, true);                         // Stripe sí la aplicó
    const o = await ops(m);
    expect(o.map((x) => [x.tipo, x.estado])).toEqual([['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'pendiente']]);
  });

  it('levantar la sanción NO resucita: membresía ya cancelada o cuenta revocada → no se reanuda', async () => {
    const a = await conSuscripcion();
    await sancionar(a.m);
    const sa = (await ops(a.m))[0];
    await preparar(sa.id);
    await resultado(sa.id, true);
    await sync(a.sub, 'cancelada'); // la suscripción terminó en Stripe mientras estaba sancionado
    await levantar(a.m);
    expect((await ops(a.m)).filter((x) => x.tipo === 'reanudar_cobro')).toEqual([]);
    expect(await b.filas('SELECT status FROM membresias WHERE id = $1', [a.mem])).toEqual([{ status: 'cancelada' }]);

    // Reanudación creada y, antes de ejecutarse, la cuenta se revoca → se descarta al preparar.
    const c = await conSuscripcion();
    await sancionar(c.m);
    const sc = (await ops(c.m))[0];
    await preparar(sc.id);
    await resultado(sc.id, true);
    await levantar(c.m);
    const rean = (await ops(c.m)).find((x) => x.tipo === 'reanudar_cobro')!;
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [c.m.id]);
    const o = await ops(c.m);
    expect(o.find((x) => x.id === rean.id)).toMatchObject({ estado: 'descartada', motivo_descarte: 'cuenta_revocada' });
    expect(o.find((x) => x.tipo === 'cancelar_suscripcion')).toMatchObject({ causa: 'revocacion', estado: 'pendiente' });
    expect(await preparar(rean.id)).toMatchObject({ ejecutar: false });
  });
});

describe('01P · revocación: la suscripción se cancela de inmediato', () => {
  it('revocar crea UNA operación "cancelar"; si Stripe falla la revocación sigue; un cobro posterior no reactiva; el reintento es idempotente', async () => {
    const { m, sub, mem } = await conSuscripcion();
    await b.como(admin, () => b.fila(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]));
    let o = await ops(m);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ tipo: 'cancelar_suscripcion', causa: 'revocacion', estado: 'pendiente', operation_key: `cancelar:${mem}` });
    // Repetir la revocación: nada nuevo.
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    expect(await ops(m)).toHaveLength(1);

    expect(await preparar(o[0].id)).toMatchObject({ ejecutar: true, tipo: 'cancelar_suscripcion', stripe_subscription_id: sub });
    await resultado(o[0].id, false, 'api_error:500');
    expect((await usuario(m)).status).toBe('revocado');

    // Stripe sigue cobrando mientras tanto: el cobro NO reactiva (R1).
    await sync(sub, 'activa');
    expect((await usuario(m)).status).toBe('revocado');
    expect((await b.fila<{ e: string }>('SELECT _estado_membresia_checkin($1, gen_random_uuid()) AS e', [m.id])).e).toBe('cuenta_revocado');

    expect(await preparar(o[0].id)).toMatchObject({ ejecutar: true, intento: 2 });
    await resultado(o[0].id, true);
    o = await ops(m);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ estado: 'aplicada', intentos: 2 });

    // La baja llega por el webhook: membresía cancelada, sin operación nueva, sin reembolso.
    await sync(sub, 'cancelada');
    expect(await ops(m)).toHaveLength(1);
    expect((await usuario(m)).status).toBe('revocado');
    expect((await b.filas('SELECT 1 FROM reversales_pago WHERE usuario_id = $1', [m.id])).length).toBe(0);
  });

  it('revocar a un miembro sancionado: las operaciones de suspender/reanudar pendientes se descartan', async () => {
    const { m } = await conSuscripcion();
    await sancionar(m);
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    const o = await ops(m);
    expect(o.find((x) => x.tipo === 'suspender_cobro')).toMatchObject({ estado: 'descartada', motivo_descarte: 'cuenta_revocada' });
    expect(o.find((x) => x.tipo === 'cancelar_suscripcion')).toMatchObject({ estado: 'pendiente' });
  });
});

describe('01P · baja inmediata y evidencia', () => {
  it('baja inmediata por el equipo: operación "cancelar" en la misma transacción; baja que viene de Stripe: ninguna', async () => {
    const a = await conSuscripcion();
    await b.como(recep, () => b.fila('SELECT staff_cancelar_membresia($1, true, $2)', [a.m.id, 'Baja inmediata']));
    expect(await ops(a.m)).toEqual([expect.objectContaining({ tipo: 'cancelar_suscripcion', causa: 'baja_inmediata', estado: 'pendiente', operation_key: `cancelar:${a.mem}` })]);

    const c = await conSuscripcion();
    await sync(c.sub, 'cancelada');
    expect(await ops(c.m)).toEqual([]);
  });

  it('no se cancela una suscripción que hoy sostiene otra membresía viva', async () => {
    const { m, sub, mem } = await conSuscripcion();
    await b.como(recep, () => b.fila('SELECT staff_cancelar_membresia($1, true, $2)', [m.id, 'Baja inmediata']));
    const o = (await ops(m))[0];
    const otro = await b.crearPersona();
    await b.db.query(
      `INSERT INTO membresias (tenant_id, usuario_id, tier_id, status, stripe_subscription_id) SELECT tenant_id, $2, tier_id, 'activa', NULL FROM membresias WHERE id = $1`, [mem, otro.id]);
    await b.db.query(`UPDATE membresias SET stripe_subscription_id = NULL WHERE id = $1`, [mem]);
    await b.db.query(`UPDATE membresias SET stripe_subscription_id = $2 WHERE usuario_id = $1`, [otro.id, sub]);
    expect(await preparar(o.id)).toMatchObject({ ejecutar: false, estado: 'descartada', motivo: 'suscripcion_en_uso_por_otra_membresia' });
  });

  it('evidencia inmutable, sin secretos, solo lectura para admin; RPC del ejecutor solo service_role', async () => {
    const { m } = await conSuscripcion();
    await sancionar(m);
    const o = (await ops(m))[0];
    await expect(b.db.query('DELETE FROM stripe_operaciones_suscripcion WHERE id = $1', [o.id])).rejects.toThrow(/EKKO_OPERACION_INMUTABLE/);
    await expect(b.db.query(`UPDATE stripe_operaciones_suscripcion SET tipo = 'cancelar_suscripcion' WHERE id = $1`, [o.id])).rejects.toThrow(/EKKO_OPERACION_INMUTABLE/);
    await preparar(o.id);
    await resultado(o.id, true);
    await expect(b.db.query(`UPDATE stripe_operaciones_suscripcion SET estado = 'pendiente' WHERE id = $1`, [o.id])).rejects.toThrow(/EKKO_OPERACION_INMUTABLE/);

    const cols = (await b.filas<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'stripe_operaciones_suscripcion'`)).map((x) => x.c);
    expect(cols).toEqual(expect.arrayContaining(['tenant_id', 'usuario_id', 'membresia_id', 'stripe_subscription_id', 'tipo', 'operation_key', 'estado', 'intentos', 'ultimo_error', 'resultado', 'created_at', 'ultimo_intento_at', 'aplicada_at']));
    expect(cols.some((c) => /payload|secret|email|nombre/.test(c))).toBe(false);

    expect((await b.como(admin, () => b.filas('SELECT 1 FROM stripe_operaciones_suscripcion WHERE id = $1', [o.id]))).length).toBe(1);
    expect((await b.como(recep, () => b.filas('SELECT 1 FROM stripe_operaciones_suscripcion WHERE id = $1', [o.id]))).length).toBe(0);
    await expect(b.como(admin, () => b.fila(`UPDATE stripe_operaciones_suscripcion SET ultimo_error = 'x' WHERE id = $1 RETURNING id`, [o.id]))).rejects.toThrow(/permission denied/);
    const priv = async (rol: string, fn: string) => (await b.fila<{ p: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [rol, fn])).p;
    for (const fn of ['operacion_suscripcion_preparar(uuid)', 'operacion_suscripcion_resultado(uuid, boolean, text, jsonb)']) {
      expect(await priv('service_role', fn), fn).toBe(true);
      expect(await priv('authenticated', fn), fn).toBe(false);
      expect(await priv('anon', fn), fn).toBe(false);
    }
  });
});
