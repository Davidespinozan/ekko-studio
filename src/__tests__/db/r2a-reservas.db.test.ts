// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * R2-A (PKG-01I/01J/01K/01L/01M) · migración 20261004100000 contra Postgres real.
 *
 *  01I  Transiciones de asistencia: no_show → completada (sin revivir canceladas),
 *       completada → confirmada el mismo día; penalización y auditoría atómicas;
 *       nunca mueven créditos.
 *  01J  Reprogramación atómica: neto cero de créditos, rollback total ante
 *       conflicto, extras pagados trasladados con rastro (01H sigue cuadrando),
 *       fichas movidas, UN aviso.
 *  01K  Derechos desde la membresía VIVA, no desde usuarios.membresia_tier.
 *  01L  Admin lee pero no escribe por REST reservas / membresías / datos
 *       privados ni campos de negocio de usuarios.
 *  01M  Planes: slug inmutable; tipo/activo no cambian con membresías vivas;
 *       reglas.max_invitados obligatorio.
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
const CUENTA = 'acct_ekko_r2a';

type Json = Record<string, unknown>;

const reserva = (id: string) =>
  b.fila<{ status: string; check_in_at: string | null; check_in_by: string | null; check_in_method: string | null;
    invitados_count: number; invitados_extra_pagados: number; reprogramada_desde: string | null; notas: string | null;
    observaciones: string | null; duracion_min: number; recurso_id: string; cancelada_motivo: string | null }>(
    'SELECT * FROM reservas WHERE id = $1', [id]);

const usuario = (p: Persona) =>
  b.fila<{ no_shows_count: number; bloqueado_hasta: string | null }>('SELECT no_shows_count, bloqueado_hasta FROM usuarios WHERE id = $1', [p.id]);

const movimientos = (p: Persona) =>
  b.fila<{ n: number; suma: number }>(
    'SELECT count(*)::int AS n, COALESCE(SUM(delta), 0)::int AS suma FROM membresia_movimientos WHERE usuario_id = $1', [p.id]);

/** Reserva de recepción para mañana+ (sin anticipación mínima). */
async function reservarRecep(m: Persona, recurso: string, dias: number, hora: number, invitados = 0, notas: string | null = null): Promise<string> {
  const slot = await b.slot(dias, hora);
  const x = await b.como(recep, () =>
    b.fila<{ r: { reserva_id: string } }>(
      'SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, $4, $5) AS r', [m.id, recurso, slot, invitados, notas]));
  return x.r.reserva_id;
}

/** Mueve una reserva al pasado (ya terminó hace 2 h) sin pasar por la app. */
const alPasado = (id: string) =>
  b.db.query(`UPDATE reservas SET slot_inicio = now() - interval '4 hours', slot_fin = now() - interval '3 hours' WHERE id = $1`, [id]);

const corregir = (actor: Persona, id: string, accion: string, motivo = 'Corrección de prueba') =>
  b.fila<{ r: Json }>('SELECT staff_corregir_asistencia($1, $2, $3, $4) AS r', [actor.id, id, accion, motivo]).then((x) => x.r);

const reprogramar = (actor: Persona, id: string, recurso: string, slot: string, o: { dur?: number | null; inv?: number | null; notas?: string | null } = {}) =>
  b.como(actor, () =>
    b.fila<{ r: { success: boolean; reserva_id: string; reserva_anterior_id: string } }>(
      'SELECT reprogramar_reserva($1, $2, $3::timestamptz, $4, $5, $6) AS r',
      [id, recurso, slot, o.dur ?? null, o.inv ?? null, o.notas ?? null]
    ).then((x) => x.r)
  );

async function aplicarExtra(reservaId: string, m: Persona, cantidad = 1): Promise<{ success: boolean; estado?: string; motivo?: string | null }> {
  const r = await b.fila<{ r: { success: boolean; estado?: string; motivo?: string | null } }>(
    `SELECT aplicar_invitados_extra_pago($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12) AS r`,
    [`pi_${randomUUID().slice(0, 8)}`, CUENTA, b.tenantId, `evt_${randomUUID().slice(0, 8)}`, reservaId, m.id, cantidad,
     cantidad * 10000, 10000, 'mxn', new Date().toISOString(), null]
  );
  return r.r;
}

const atribuidos = (id: string) => b.fila<{ n: number }>('SELECT _extras_atribuidos($1) AS n', [id]).then((x) => x.n);

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
describe('01I · transiciones de asistencia', () => {
  it('no_show (cron) → "sí asistió": completada con check-in manual, revierte la falta y el bloqueo que causó; créditos intactos; auditado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter'); // 3 créditos
    const e = await b.crearEstudio();
    const id = await reservarRecep(m, e, 1, 9);
    await b.db.query('UPDATE usuarios SET no_shows_count = 2 WHERE id = $1', [m.id]);
    await alPasado(id);
    await b.fila('SELECT marcar_no_shows()');
    expect((await reserva(id)).status).toBe('no_show');
    const pen = await usuario(m);
    expect(pen.no_shows_count).toBe(3);
    expect(pen.bloqueado_hasta).not.toBeNull(); // umbral 3 → bloqueo
    const creditosAntes = await b.creditos(m);
    const movAntes = await movimientos(m);

    const r = await corregir(recep, id, 'asistio', 'Sí vino, no le hicieron check-in');
    expect(r).toMatchObject({ success: true, status: 'completada', penalizacion: { no_shows_count: 2, bloqueado_hasta: null } });
    const fila = await reserva(id);
    expect(fila).toMatchObject({ status: 'completada', check_in_by: recep.id, check_in_method: 'manual' });
    expect(fila.check_in_at).not.toBeNull();
    expect(await usuario(m)).toMatchObject({ no_shows_count: 2, bloqueado_hasta: null });
    expect(await b.creditos(m)).toBe(creditosAntes);
    expect(await movimientos(m)).toEqual(movAntes);
    const audit = await b.filas<{ antes: Json; despues: Json; motivo: string; actor_usuario_id: string }>(
      `SELECT antes, despues, motivo, actor_usuario_id FROM audit_log WHERE accion = 'asistencia_correction' AND target_id = $1`, [m.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ motivo: 'Sí vino, no le hicieron check-in', actor_usuario_id: recep.id,
      antes: { reserva_status: 'no_show', no_shows_count: 3 }, despues: { reserva_status: 'completada', no_shows_count: 2 } });

    // Repetir: ya completada → rechazo; la falta NO se revierte dos veces.
    await expect(corregir(recep, id, 'asistio')).rejects.toThrow(/EKKO_YA_COMPLETADA/);
    expect((await usuario(m)).no_shows_count).toBe(2);
  });

  it('bloqueo que no se debe a esta falta (sigue sobre el umbral) se conserva', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 1, 9);
    await b.db.query(`UPDATE usuarios SET no_shows_count = 5, bloqueado_hasta = now() + interval '5 days' WHERE id = $1`, [m.id]);
    await alPasado(id);
    await b.fila('SELECT marcar_no_shows()');
    const antes = await usuario(m);
    await corregir(admin, id, 'asistio');
    const despues = await usuario(m);
    expect(despues.no_shows_count).toBe(antes.no_shows_count - 1);
    expect(despues.bloqueado_hasta).toEqual(antes.bloqueado_hasta);
  });

  it('una reserva CANCELADA (por el miembro o el estudio) no se revive: sin cambios ni créditos', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const e = await b.crearEstudio();
    for (const estado of ['cancelada', 'cancelada_admin']) {
      const id = await reservarRecep(m, e, 2, estado === 'cancelada' ? 9 : 11);
      await b.db.query(`UPDATE reservas SET status = $2, cancelada_at = now() WHERE id = $1`, [id, estado]);
      await alPasado(id);
      const creditos = await b.creditos(m);
      const mov = await movimientos(m);
      await expect(corregir(recep, id, 'asistio')).rejects.toThrow(/EKKO_TRANSICION_INVALIDA: Una reserva cancelada no se revive/);
      expect((await reserva(id)).status).toBe(estado);
      expect(await b.creditos(m)).toBe(creditos);
      expect(await movimientos(m)).toEqual(mov);
    }
  });

  it('confirmada → rechazo; no_show de una sesión futura → rechazo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const id = await reservarRecep(m, e, 2, 13);
    await expect(corregir(recep, id, 'asistio')).rejects.toThrow(/EKKO_TRANSICION_INVALIDA/);
    await b.db.query(`UPDATE reservas SET status = 'no_show' WHERE id = $1`, [id]);
    await expect(corregir(recep, id, 'asistio')).rejects.toThrow(/EKKO_SESION_NO_INICIA/);
  });

  it('guarda de identidad y cuenta revocada aplican al revivir un no_show; todo se revierte (la falta sigue)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 1, 9);
    await alPasado(id);
    await b.fila('SELECT marcar_no_shows()');
    const pen = await usuario(m);

    await b.db.query('UPDATE usuarios SET identidad_completa = false WHERE id = $1', [m.id]);
    await expect(corregir(recep, id, 'asistio')).rejects.toThrow(/EKKO_IDENTIDAD_INCOMPLETA/);
    expect((await reserva(id)).status).toBe('no_show');
    expect(await usuario(m)).toEqual(pen);

    await b.db.query(`UPDATE usuarios SET identidad_completa = true, status = 'revocado' WHERE id = $1`, [m.id]);
    await expect(corregir(recep, id, 'asistio')).rejects.toThrow(/EKKO_CUENTA_REVOCADA/);
    expect((await reserva(id)).status).toBe('no_show');
    expect(await usuario(m)).toEqual(pen);
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE accion = 'asistencia_correction' AND target_id = $1`, [m.id])).length).toBe(0);
  });

  it('deshacer check-in: solo completada del mismo día → confirmada, limpia columnas y audita; otros estados u otro día → rechazo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const id = await reservarRecep(m, e, 1, 15);
    await b.db.query(`UPDATE reservas SET status = 'completada', check_in_at = now(), check_in_by = $2, check_in_method = 'manual' WHERE id = $1`, [id, recep.id]);
    const r = await corregir(recep, id, 'deshacer_checkin', 'Check-in al miembro equivocado');
    expect(r).toMatchObject({ success: true, status: 'confirmada' });
    expect(await reserva(id)).toMatchObject({ status: 'confirmada', check_in_at: null, check_in_by: null, check_in_method: null });
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE accion = 'checkin_correction' AND target_id = $1`, [m.id])).length).toBe(1);

    await expect(corregir(recep, id, 'deshacer_checkin')).rejects.toThrow(/EKKO_TRANSICION_INVALIDA/); // confirmada
    await b.db.query(`UPDATE reservas SET status = 'cancelada_admin' WHERE id = $1`, [id]);
    await expect(corregir(recep, id, 'deshacer_checkin')).rejects.toThrow(/EKKO_TRANSICION_INVALIDA/);

    const viejo = await reservarRecep(m, e, 1, 17);
    await b.db.query(`UPDATE reservas SET status = 'completada', check_in_at = now() - interval '2 days', check_in_method = 'qr' WHERE id = $1`, [viejo]);
    await expect(corregir(recep, viejo, 'deshacer_checkin')).rejects.toThrow(/EKKO_FUERA_DE_PLAZO/);
    expect((await reserva(viejo)).status).toBe('completada');
  });

  it('actor: miembro o staff revocado → NO_AUTORIZADO; motivo corto o acción desconocida → rechazo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 1, 9);
    await alPasado(id);
    await b.fila('SELECT marcar_no_shows()');
    await expect(corregir(m, id, 'asistio')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    const exRecep = await b.crearPersona({ rol: 'recepcionista', status: 'revocado' });
    await expect(corregir(exRecep, id, 'asistio')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(corregir(recep, id, 'asistio', 'x')).rejects.toThrow(/EKKO_MOTIVO_REQUERIDO/);
    await expect(corregir(recep, id, 'revivir')).rejects.toThrow(/EKKO_ACCION_INVALIDA/);
    expect((await reserva(id)).status).toBe('no_show');
  });

  it('una entrada directa a completada desde no_show también pasa por la guarda de identidad (cualquier camino)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 1, 9);
    await b.db.query(`UPDATE reservas SET status = 'no_show' WHERE id = $1`, [id]);
    await b.db.query('UPDATE usuarios SET contrato_firmado = false WHERE id = $1', [m.id]);
    await expect(b.db.query(`UPDATE reservas SET status = 'completada', check_in_at = now() WHERE id = $1`, [id])).rejects.toThrow(/EKKO_CONTRATO_PENDIENTE/);
  });

  it('cron y cancelación: transición condicionada / fila bloqueada', async () => {
    const cron = await b.fila<{ d: string }>(`SELECT pg_get_functiondef('marcar_no_shows'::regproc) AS d`);
    expect(cron.d).toMatch(/WHERE id = r\.id AND status = 'confirmada' AND check_in_at IS NULL;\s+IF NOT FOUND THEN\s+CONTINUE;/);
    const cancel = await b.fila<{ d: string }>(`SELECT pg_get_functiondef('cancelar_reserva_atomic'::regproc) AS d`);
    expect(cancel.d).toContain('FROM reservas WHERE id = p_reserva_id FOR UPDATE');
    // El cron no pisa una reserva que ya tuvo check-in.
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 1, 9);
    await alPasado(id);
    await b.db.query(`UPDATE reservas SET check_in_at = now() WHERE id = $1`, [id]);
    await b.fila('SELECT marcar_no_shows()');
    expect((await reserva(id)).status).toBe('confirmada');
    expect((await usuario(m)).no_shows_count).toBe(0);
  });

  it('grants: corrección solo service_role; reprogramar authenticated (no anon)', async () => {
    const priv = async (rol: string, fn: string) =>
      (await b.fila<{ p: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [rol, fn])).p;
    const corr = 'staff_corregir_asistencia(uuid, uuid, text, text)';
    const rep = 'reprogramar_reserva(uuid, uuid, timestamptz, integer, integer, text)';
    expect(await priv('service_role', corr)).toBe(true);
    expect(await priv('authenticated', corr)).toBe(false);
    expect(await priv('anon', corr)).toBe(false);
    expect(await priv('authenticated', rep)).toBe(true);
    expect(await priv('anon', rep)).toBe(false);
    for (const f of ['_tier_vivo(uuid)', '_extras_atribuidos(uuid)']) {
      expect(await priv('authenticated', f), f).toBe(false);
      expect(await priv('anon', f), f).toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('01J · reprogramación atómica', () => {
  it('éxito: vieja cancelada_admin "Reprogramada", nueva enlazada con notas/observaciones; créditos netos cero; UN aviso; auditado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter'); // 3 créditos
    const e1 = await b.crearEstudio();
    const e2 = await b.crearEstudio();
    const vieja = await reservarRecep(m, e1, 2, 10, 1, 'trae tripié');
    await b.db.query(`UPDATE reservas SET observaciones = 'cliente frecuente' WHERE id = $1`, [vieja]);
    expect(await b.creditos(m)).toBe(2);
    const nuevoSlot = await b.slot(3, 12);

    const r = await reprogramar(recep, vieja, e2, nuevoSlot);
    expect(r).toMatchObject({ success: true, reserva_anterior_id: vieja });
    expect(await reserva(vieja)).toMatchObject({ status: 'cancelada_admin', cancelada_motivo: 'Reprogramada' });
    expect(await reserva(r.reserva_id)).toMatchObject({
      status: 'confirmada', recurso_id: e2, reprogramada_desde: vieja, notas: 'trae tripié',
      observaciones: 'cliente frecuente', invitados_count: 1, duracion_min: 60
    });
    expect(await b.creditos(m)).toBe(2);
    const mov = await b.filas<{ reserva_id: string; tipo: string; delta: number }>(
      `SELECT reserva_id, tipo, delta FROM membresia_movimientos WHERE usuario_id = $1 AND reserva_id IS NOT NULL ORDER BY created_at, tipo`, [m.id]);
    expect(mov.filter((x) => x.reserva_id === vieja).map((x) => [x.tipo, x.delta]).sort()).toEqual([['debito', -1], ['devolucion', 1]]);
    expect(mov.filter((x) => x.reserva_id === r.reserva_id).map((x) => [x.tipo, x.delta])).toEqual([['debito', -1]]);

    const avisos = await b.filas<{ tipo: string; metadata: Json }>(`SELECT tipo, metadata FROM notificaciones WHERE usuario_id = $1 ORDER BY creada_at`, [m.id]);
    expect(avisos.filter((a) => a.tipo === 'reserva_reprogramada')).toHaveLength(1);
    expect(avisos.find((a) => a.tipo === 'reserva_reprogramada')?.metadata).toMatchObject({ reserva_id: r.reserva_id, reserva_anterior_id: vieja });
    expect(avisos.some((a) => a.tipo === 'reserva_confirmada' && a.metadata.reserva_id === r.reserva_id)).toBe(false);
    expect(avisos.some((a) => /cancel/.test(a.tipo) && a.metadata.reserva_id === vieja)).toBe(false);

    const audit = await b.filas<{ accion: string }>(`SELECT accion FROM audit_log WHERE target_id = $1 ORDER BY creada_at`, [m.id]);
    expect(audit.map((a) => a.accion)).toEqual(expect.arrayContaining(['reserva_cancelada_por_estudio', 'reserva_reprogramada']));
  });

  it('conflicto (horario ocupado) → rollback TOTAL: la original sigue confirmada, sin reserva nueva, sin movimientos, sin avisos', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    const otro = await b.crearPersona();
    await b.activar(otro, 'premium');
    const e = await b.crearEstudio();
    const vieja = await reservarRecep(m, e, 4, 10);
    const ocupado = await b.slot(4, 14);
    await reservarRecep(otro, e, 4, 14);
    const creditos = await b.creditos(m);
    const mov = await movimientos(m);
    const reservas = (await b.filas('SELECT 1 FROM reservas WHERE usuario_id = $1', [m.id])).length;
    const avisos = (await b.filas('SELECT 1 FROM notificaciones WHERE usuario_id = $1', [m.id])).length;

    await expect(reprogramar(recep, vieja, e, ocupado)).rejects.toThrow(/EKKO_SLOT_OCUPADO/);
    expect((await reserva(vieja)).status).toBe('confirmada');
    expect(await b.creditos(m)).toBe(creditos);
    expect(await movimientos(m)).toEqual(mov);
    expect((await b.filas('SELECT 1 FROM reservas WHERE usuario_id = $1', [m.id])).length).toBe(reservas);
    expect((await b.filas('SELECT 1 FROM notificaciones WHERE usuario_id = $1', [m.id])).length).toBe(avisos);
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE target_id = $1 AND accion IN ('reserva_reprogramada', 'reserva_cancelada_por_estudio')`, [m.id])).length).toBe(0);
  });

  it('el nuevo horario puede solapar o tocar el viejo (mismo set): la vieja se libera dentro de la transacción', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const vieja = await reservarRecep(m, e, 5, 10);
    const media = (await b.fila<{ t: string }>(`SELECT ($1::timestamptz + interval '30 minutes')::text AS t`, [await b.slot(5, 10)])).t;
    const r = await reprogramar(recep, vieja, e, media);
    expect((await reserva(r.reserva_id)).status).toBe('confirmada');
  });

  it('rechazos sin efectos: sesión ya iniciada, no confirmada, mismo horario, miembro como actor', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const pasada = await reservarRecep(m, e, 1, 8);
    await alPasado(pasada);
    await expect(reprogramar(recep, pasada, e, await b.slot(6, 10))).rejects.toThrow(/EKKO_REPROGRAMAR_PASADA/);
    const v = await reservarRecep(m, e, 6, 16);
    await expect(reprogramar(recep, v, e, await b.slot(6, 16))).rejects.toThrow(/EKKO_MISMO_HORARIO/);
    await expect(reprogramar(m, v, e, await b.slot(6, 18))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await b.db.query(`UPDATE reservas SET status = 'cancelada' WHERE id = $1`, [v]);
    await expect(reprogramar(recep, v, e, await b.slot(6, 18))).rejects.toThrow(/EKKO_REPROGRAMAR_NO_VIGENTE/);
  });

  it('extras pagados viajan con traslado trazable; 01H sigue cuadrando (aplicar sobre la nueva, rechazo sobre la vieja); fichas movidas', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium'); // max_invitados 4
    const e1 = await b.crearEstudio();
    const e2 = await b.crearEstudio();
    const r0 = await reservarRecep(m, e1, 7, 10, 2);
    expect(await aplicarExtra(r0, m)).toMatchObject({ success: true, estado: 'aplicado' });
    for (const nombre of ['Uno', 'Dos', 'Tres']) {
      await b.fila('SELECT registrar_ficha_invitado($1, $2, $3, NULL)', [recep.id, r0, nombre]);
    }
    const pagos = await b.filas<{ id: string }>(`SELECT id FROM invitados_extra_pagos WHERE reserva_id = $1`, [r0]);

    const r1 = (await reprogramar(recep, r0, e2, await b.slot(8, 10))).reserva_id;
    expect((await reserva(r0)).invitados_extra_pagados).toBe(0);
    expect((await reserva(r1)).invitados_extra_pagados).toBe(1);
    expect(await atribuidos(r0)).toBe(0);
    expect(await atribuidos(r1)).toBe(1);
    const tras = await b.filas<{ pago_id: string; reserva_origen_id: string; reserva_destino_id: string; cantidad: number; actor_usuario_id: string }>(
      'SELECT pago_id, reserva_origen_id, reserva_destino_id, cantidad, actor_usuario_id FROM invitados_extra_traslados WHERE reserva_origen_id = $1', [r0]);
    expect(tras).toEqual([{ pago_id: pagos[0].id, reserva_origen_id: r0, reserva_destino_id: r1, cantidad: 1, actor_usuario_id: recep.id }]);
    // La evidencia del pago (01H) no se reescribió.
    expect((await b.fila<{ reserva_id: string }>('SELECT reserva_id FROM invitados_extra_pagos WHERE id = $1', [pagos[0].id])).reserva_id).toBe(r0);
    const fichas = await b.filas<{ nombre: string; es_extra: boolean }>('SELECT nombre, es_extra FROM reserva_invitados WHERE reserva_id = $1 ORDER BY created_at, id', [r1]);
    expect(fichas).toHaveLength(3);
    expect(fichas.filter((f) => f.es_extra)).toHaveLength(1);
    expect((await b.filas('SELECT 1 FROM reserva_invitados WHERE reserva_id = $1', [r0])).length).toBe(0);

    // 01H: un pago nuevo sobre la reserva NUEVA aplica (contador = atribuidos).
    expect(await aplicarExtra(r1, m)).toMatchObject({ success: true, estado: 'aplicado' });
    expect((await reserva(r1)).invitados_extra_pagados).toBe(2);
    // Sobre la VIEJA (cancelada) no aplica: evidencia no_aplicado, sin derechos.
    expect(await aplicarExtra(r0, m)).toMatchObject({ estado: 'no_aplicado', motivo: 'reserva_no_aplicable' });

    // Reprogramar otra vez: los dos pagos se trasladan; la cadena se resuelve al último destino.
    const r2 = (await reprogramar(recep, r1, e1, await b.slot(9, 10))).reserva_id;
    expect((await reserva(r2)).invitados_extra_pagados).toBe(2);
    expect([await atribuidos(r0), await atribuidos(r1), await atribuidos(r2)]).toEqual([0, 0, 2]);

    // Invariante global: el contador de cada reserva = pagos aplicados atribuidos.
    const desc = await b.filas(`SELECT id FROM reservas WHERE invitados_extra_pagados <> _extras_atribuidos(id)`);
    expect(desc).toEqual([]);
  });

  it('extras que no caben en el estudio destino → EKKO_EXTRAS_EXCEDEN_TOPE y rollback (sin traslados)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const chico = await b.crearEstudio();
    await b.db.query('UPDATE recursos SET max_invitados_extra = 0 WHERE id = $1', [chico]);
    const r0 = await reservarRecep(m, e, 10, 10, 0);
    await aplicarExtra(r0, m);
    await expect(reprogramar(recep, r0, chico, await b.slot(11, 10))).rejects.toThrow(/EKKO_EXTRAS_EXCEDEN_TOPE/);
    expect(await reserva(r0)).toMatchObject({ status: 'confirmada', invitados_extra_pagados: 1 });
    expect((await b.filas('SELECT 1 FROM invitados_extra_traslados WHERE reserva_origen_id = $1', [r0])).length).toBe(0);
  });

  it('fichas registradas que la nueva no cubre → EKKO_FICHAS_EXCEDEN y rollback', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const r0 = await reservarRecep(m, e, 12, 10, 2);
    await b.fila('SELECT registrar_ficha_invitado($1, $2, $3, NULL)', [recep.id, r0, 'Ana']);
    await b.fila('SELECT registrar_ficha_invitado($1, $2, $3, NULL)', [recep.id, r0, 'Beto']);
    await expect(reprogramar(recep, r0, e, await b.slot(13, 10), { inv: 1 })).rejects.toThrow(/EKKO_FICHAS_EXCEDEN/);
    expect((await reserva(r0)).status).toBe('confirmada');
    expect((await b.filas('SELECT 1 FROM reserva_invitados WHERE reserva_id = $1', [r0])).length).toBe(2);
  });

  it('extras inconsistentes (contador sin pagos que lo respalden) → no se reprograma', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const e = await b.crearEstudio();
    const r0 = await reservarRecep(m, e, 14, 10);
    await b.db.query('UPDATE reservas SET invitados_extra_pagados = 1 WHERE id = $1', [r0]);
    await expect(reprogramar(recep, r0, e, await b.slot(15, 10))).rejects.toThrow(/EKKO_EXTRAS_INCONSISTENTES/);
    expect((await reserva(r0)).status).toBe('confirmada');
  });

  it('traslados inmutables y con RLS (solo lectura admin)', async () => {
    const t = await b.fila<{ id: string }>('SELECT id FROM invitados_extra_traslados LIMIT 1');
    await expect(b.db.query('UPDATE invitados_extra_traslados SET cantidad = 5 WHERE id = $1', [t.id])).rejects.toThrow(/EKKO_TRASLADO_INMUTABLE/);
    await expect(b.db.query('DELETE FROM invitados_extra_traslados WHERE id = $1', [t.id])).rejects.toThrow(/EKKO_TRASLADO_INMUTABLE/);
    expect((await b.como(admin, () => b.filas('SELECT 1 FROM invitados_extra_traslados'))).length).toBeGreaterThan(0);
    expect((await b.como(recep, () => b.filas('SELECT 1 FROM invitados_extra_traslados'))).length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('01K · el plan que da derechos es el de la membresía VIVA', () => {
  it('caché dice premium pero la membresía viva es esencial → sin acceso a sets premium ni 4 invitados (miembro y recepción)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial'); // max_invitados 2
    await b.db.query(`UPDATE usuarios SET membresia_tier = 'premium' WHERE id = $1`, [m.id]);
    const soloPremium = await b.crearEstudio(['premium']);
    const abierto = await b.crearEstudio();
    const slot = await b.slot(3, 9);
    await expect(b.reservar(m, soloPremium, slot)).rejects.toThrow(/EKKO_TIER_NO_PERMITIDO/);
    await expect(b.como(recep, () => b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, 0, NULL)', [m.id, soloPremium, slot])))
      .rejects.toThrow(/EKKO_TIER_NO_PERMITIDO/);
    await expect(b.como(m, () => b.fila('SELECT reservar_recurso_atomic($1, $2::timestamptz, 60, 4)', [abierto, slot]))).rejects.toThrow(/EKKO_INVITADOS_EXCEDEN/);
    await expect(b.como(recep, () => b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, 3, NULL)', [m.id, abierto, slot])))
      .rejects.toThrow(/EKKO_INVITADOS_EXCEDEN/);
  });

  it('caché dice esencial pero la membresía viva es premium → acceso premium y 4 invitados', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    await b.db.query(`UPDATE usuarios SET membresia_tier = 'esencial' WHERE id = $1`, [m.id]);
    const soloPremium = await b.crearEstudio(['premium']);
    const slot = await b.slot(3, 11);
    const r = await b.como(m, () => b.fila<{ r: { success: boolean } }>('SELECT reservar_recurso_atomic($1, $2::timestamptz, 60, 4) AS r', [soloPremium, slot]));
    expect(r.r.success).toBe(true);
  });

  it('caché con plan pero SIN membresía viva → EKKO_SIN_MEMBRESIA (antes de la puerta de plan)', async () => {
    const m = await b.crearPersona();
    await b.db.query(`UPDATE usuarios SET membresia_tier = 'premium' WHERE id = $1`, [m.id]);
    const soloPremium = await b.crearEstudio(['premium']);
    const slot = await b.slot(3, 13);
    await expect(b.reservar(m, soloPremium, slot)).rejects.toThrow(/EKKO_SIN_MEMBRESIA/);
    await expect(b.como(recep, () => b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, 0, NULL)', [m.id, soloPremium, slot])))
      .rejects.toThrow(/EKKO_SIN_MEMBRESIA/);
  });

  it('las RPC ya no leen usuarios.membresia_tier ni los fallbacks legados por slug', async () => {
    for (const fn of ['reservar_recurso_atomic', 'reservar_para_miembro_atomic']) {
      const d = (await b.fila<{ d: string }>(`SELECT pg_get_functiondef($1::regproc) AS d`, [fn])).d;
      expect(d, fn).toContain('_tier_vivo(');
      expect(d, fn).not.toMatch(/v_(usuario|miembro)\.membresia_tier/);
      expect(d, fn).not.toMatch(/max_invitados_por_tier|WHEN 'pro' THEN/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PKG-02C (20261006100000): en estas tablas ninguna política autoriza escribir, así
// que el GRANT de INSERT/UPDATE/DELETE a authenticated se retiró. El rechazo ahora
// es "permission denied" (antes del RLS) en vez de 0 filas / violación de RLS. El
// resultado de 01L es el mismo: el admin lee y no escribe estado de negocio.
const SIN_PERMISO = /permission denied|row-level security/;
describe('01L · admin: lee, no escribe estado de negocio por REST', () => {
  it('reservas: admin lee; UPDATE/DELETE/INSERT rechazados (sin GRANT ni policy)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'premium');
    const id = await reservarRecep(m, await b.crearEstudio(), 2, 7);
    await b.como(admin, async () => {
      expect((await b.filas('SELECT 1 FROM reservas WHERE id = $1', [id])).length).toBe(1);
      await expect(b.filas(`UPDATE reservas SET status = 'completada' WHERE id = $1 RETURNING id`, [id])).rejects.toThrow(SIN_PERMISO);
      await expect(b.filas(`DELETE FROM reservas WHERE id = $1 RETURNING id`, [id])).rejects.toThrow(SIN_PERMISO);
      await expect(b.db.query(
        `INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, status, folio)
         SELECT tenant_id, recurso_id, usuario_id, slot_inicio + interval '1 day', slot_fin + interval '1 day', 60, 'confirmada', 'EKK-X' FROM reservas WHERE id = $1`, [id]))
        .rejects.toThrow(SIN_PERMISO);
    });
    expect((await reserva(id)).status).toBe('confirmada');
  });

  it('membresías: admin lee; no cambia créditos, estado ni borra (el ledger no se pierde)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'starter');
    await b.como(admin, async () => {
      expect((await b.filas('SELECT 1 FROM membresias WHERE usuario_id = $1', [m.id])).length).toBe(1);
      await expect(b.filas(`UPDATE membresias SET creditos_restantes = 99, status = 'activa' WHERE usuario_id = $1 RETURNING id`, [m.id])).rejects.toThrow(SIN_PERMISO);
      await expect(b.filas(`DELETE FROM membresias WHERE usuario_id = $1 RETURNING id`, [m.id])).rejects.toThrow(SIN_PERMISO);
    });
    expect(await b.creditos(m)).toBe(3);
  });

  it('datos privados: admin lee; no escribe', async () => {
    const m = await b.crearPersona();
    await b.db.query(`INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, stripe_customer_id) VALUES ($1, $2, 'cus_real') ON CONFLICT (usuario_id) DO UPDATE SET stripe_customer_id = 'cus_real'`, [m.id, b.tenantId]);
    await b.como(admin, async () => {
      expect((await b.filas('SELECT stripe_customer_id FROM usuarios_datos_privados WHERE usuario_id = $1', [m.id]))).toEqual([{ stripe_customer_id: 'cus_real' }]);
      await expect(b.filas(`UPDATE usuarios_datos_privados SET stripe_customer_id = 'cus_otro' WHERE usuario_id = $1 RETURNING usuario_id`, [m.id])).rejects.toThrow(SIN_PERMISO);
    });
    expect((await b.fila<{ c: string }>('SELECT stripe_customer_id AS c FROM usuarios_datos_privados WHERE usuario_id = $1', [m.id])).c).toBe('cus_real');
    await b.como(admin, async () => {
    });
    expect(await b.como(recep, () => b.filas('SELECT 1 FROM usuarios_datos_privados WHERE usuario_id = $1', [m.id]))).toEqual([]);
  });

  it('usuarios: admin no muta plan, puntero de membresía, penalización, sanción, rol, email ni contrato; sí nombre/teléfono/avatar/notas/revocar', async () => {
    const m = await b.crearPersona();
    for (const set of ["membresia_tier = 'premium'", 'membresia_activa_id = gen_random_uuid()', 'no_shows_count = 7',
      "bloqueado_hasta = now() + interval '1 day'", "sancionado_at = now()", "sancion_motivo = 'x'", "rol = 'admin'",
      "email = 'otro@x.mx'", 'contrato_firmado = false', 'invitado = true']) {
      await expect(b.como(admin, () => b.fila(`UPDATE usuarios SET ${set} WHERE id = $1`, [m.id])), set).rejects.toThrow(/EKKO_CAMPO_PROTEGIDO/);
    }
    await b.como(admin, () => b.fila(
      `UPDATE usuarios SET nombre = 'Ana Admin', telefono = '6670000000', avatar_url = 'https://x/a.jpg', notas_admin = 'VIP' WHERE id = $1`, [m.id]));
    await b.como(admin, () => b.fila(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]));
    expect(await b.fila('SELECT nombre, notas_admin, status FROM usuarios WHERE id = $1', [m.id]))
      .toEqual({ nombre: 'Ana Admin', notas_admin: 'VIP', status: 'revocado' });
    // Las transiciones de servidor (service_role / DEFINER) siguen funcionando.
    await b.db.query(`UPDATE usuarios SET no_shows_count = 1 WHERE id = $1`, [m.id]);
  });

  it('usuarios: el admin ya no inserta filas por REST', async () => {
    await expect(b.como(admin, () => b.fila(
      `INSERT INTO usuarios (tenant_id, email, nombre, rol) VALUES ($1, 'nuevo@x.mx', 'Nuevo', 'admin')`, [b.tenantId])))
      .rejects.toThrow(/row-level security/);
  });

  it('policies: sin FOR ALL de admin en reservas / membresías / datos privados', async () => {
    const pol = await b.filas<{ tablename: string; policyname: string; cmd: string }>(
      `SELECT tablename, policyname, cmd FROM pg_policies
       WHERE tablename IN ('reservas', 'membresias', 'usuarios_datos_privados') AND cmd <> 'SELECT'`);
    expect(pol).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('01M · planes', () => {
  const nuevoPlan = (slug: string, reglas: string) =>
    b.db.query(
      `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, reglas, activo)
       SELECT tenant_id, $2, 'Plan ' || $2, precio_centavos, moneda, periodo, tipo, $3::jsonb, true FROM tiers WHERE slug = 'esencial' AND tenant_id = $1`,
      [b.tenantId, slug, reglas]);

  it('slug inmutable (para cualquier actor)', async () => {
    await expect(b.db.query(`UPDATE tiers SET slug = 'premium-2' WHERE slug = 'premium' AND tenant_id = $1`, [b.tenantId]))
      .rejects.toThrow(/EKKO_TIER_SLUG_INMUTABLE/);
    await expect(b.como(admin, () => b.fila(`UPDATE tiers SET slug = 'premium-2' WHERE slug = 'premium' AND tenant_id = $1`, [b.tenantId])))
      .rejects.toThrow(/EKKO_TIER_SLUG_INMUTABLE/);
  });

  it('con membresías vivas: tipo y desactivar → EKKO_TIER_EN_USO; nombre, precio y "en venta" sí; sin vivas: se puede', async () => {
    await nuevoPlan('plan-en-uso', '{"max_invitados": 1}');
    const m = await b.crearPersona();
    await b.activar(m, 'plan-en-uso');
    const upd = (set: string) => b.como(admin, () => b.fila(`UPDATE tiers SET ${set} WHERE slug = 'plan-en-uso' AND tenant_id = $1`, [b.tenantId]));
    await expect(upd(`tipo = 'creditos'`)).rejects.toThrow(/EKKO_TIER_EN_USO: 1 membresía/);
    await expect(upd('activo = false')).rejects.toThrow(/EKKO_TIER_EN_USO/);
    await upd(`nombre = 'Renombrado', precio_centavos = 99900, en_venta = false`);
    // Mismo tipo en el PATCH (la pantalla manda todos los campos) → no es cambio.
    await upd(`tipo = 'tiempo'`);

    await nuevoPlan('plan-libre', '{"max_invitados": 0}');
    await b.como(admin, () => b.fila(`UPDATE tiers SET activo = false WHERE slug = 'plan-libre' AND tenant_id = $1`, [b.tenantId]));
    await b.db.query(`UPDATE tiers SET activo = true, tipo = 'hibrido', clases_incluidas = 3, duracion_dias = 30 WHERE slug = 'plan-libre' AND tenant_id = $1`, [b.tenantId]);
  });

  it('reglas.max_invitados obligatorio, numérico y ≥ 0', async () => {
    for (const reglas of ['{}', '{"max_invitados": -1}', '{"max_invitados": "3"}', '{"max_invitados": 1.5}', '{"max_invitados": null}', '{"recomendado": true}']) {
      await expect(nuevoPlan(`plan-mal-${randomUUID().slice(0, 6)}`, reglas), reglas).rejects.toThrow(/tiers_max_invitados_obligatorio/);
    }
    await expect(b.db.query(`UPDATE tiers SET reglas = reglas - 'max_invitados' WHERE slug = 'premium' AND tenant_id = $1`, [b.tenantId]))
      .rejects.toThrow(/tiers_max_invitados_obligatorio/);
    await nuevoPlan('plan-bien', '{"max_invitados": 0}');
    // Sin reglas en el INSERT → default explícito de 0 invitados (no '{}').
    await b.db.query(
      `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo)
       SELECT tenant_id, 'plan-sin-reglas', 'Sin reglas', precio_centavos, moneda, periodo, tipo FROM tiers WHERE slug = 'esencial' AND tenant_id = $1`, [b.tenantId]);
    expect((await b.fila<{ r: unknown }>(`SELECT reglas AS r FROM tiers WHERE slug = 'plan-sin-reglas'`)).r).toEqual({ max_invitados: 0 });
  });

  it('usuarios.membresia_tier queda documentado como caché de display', async () => {
    const c = await b.fila<{ c: string }>(`SELECT col_description('usuarios'::regclass,
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'usuarios'::regclass AND attname = 'membresia_tier')) AS c`);
    expect(c.c).toMatch(/CACHÉ DE DISPLAY/);
  });
});
