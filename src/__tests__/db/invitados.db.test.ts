// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-01H · migración 20261003100000 contra un Postgres real (PGlite).
 *
 * Invariantes:
 *   ONE STRIPE PAYMENTINTENT → AT MOST ONE GUEST-EXTRA APPLICATION.
 *   reservas.invitados_extra_pagados = SUM(cantidad) de invitados_extra_pagos 'aplicado'.
 *   Un pago que no puede aplicarse deja evidencia no_aplicado + UNA revisión, sin tocar derechos.
 *   Las fichas de recepción no pasan de invitados_count + invitados_extra_pagados.
 *
 * Concurrencia: PGlite es de UNA conexión, así que las "llamadas simultáneas"
 * aquí se serializan; se prueba la semántica (idempotencia, tope bajo el lock de
 * la reserva) y se verifica que la función toma los locks que la protegen en
 * Postgres real (advisory por PI → FOR UPDATE de la reserva).
 */

let b: BaseDePrueba;
let m: Persona;
let recep: Persona;
let estudio: string;
const CUENTA = 'acct_ekko_test';

type Res = { success: boolean; idempotente?: boolean; estado?: string; motivo?: string | null; reason?: string; revision_creada?: boolean };

async function reservaCon(invitados: number, dias = 3, hora = 10): Promise<string> {
  const slot = await b.slot(dias, hora);
  const r = await b.como(m, () =>
    b.fila<{ r: { success: boolean; reserva_id: string } }>('SELECT reservar_recurso_atomic($1, $2::timestamptz, 60, $3) AS r', [estudio, slot, invitados])
  );
  expect(r.r.success).toBe(true);
  return r.r.reserva_id;
}

async function aplicar(o: {
  pi?: string; reserva: string; cantidad?: number; monto?: number; precio?: number | null; moneda?: string;
  cuenta?: string; tenant?: string; usuario?: string; pagadoAt?: string; evento?: string; tenantMeta?: string | null;
}): Promise<Res> {
  const cantidad = o.cantidad ?? 1;
  const precio = o.precio === undefined ? 10000 : o.precio;
  const r = await b.fila<{ r: Res }>(
    `SELECT aplicar_invitados_extra_pago($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12) AS r`,
    [o.pi ?? `pi_${randomUUID().slice(0, 8)}`, o.cuenta ?? CUENTA, o.tenant ?? b.tenantId, o.evento ?? `evt_${randomUUID().slice(0, 8)}`,
     o.reserva, o.usuario ?? m.id, cantidad, o.monto ?? cantidad * (precio ?? 10000), precio, o.moneda ?? 'mxn',
     o.pagadoAt ?? new Date().toISOString(), o.tenantMeta ?? null]
  );
  return r.r;
}
const contador = (reserva: string) =>
  b.fila<{ c: number; s: number }>(
    `SELECT r.invitados_extra_pagados AS c,
            (SELECT COALESCE(SUM(cantidad), 0)::int FROM invitados_extra_pagos WHERE reserva_id = r.id AND estado = 'aplicado') AS s
     FROM reservas r WHERE r.id = $1`, [reserva]);
const evidencia = (pi: string) => b.filas<{ estado: string; motivo: string | null }>('SELECT estado, motivo FROM invitados_extra_pagos WHERE stripe_payment_intent_id = $1', [pi]);
const revisionesDe = (pi: string) => b.filas<{ tipo: string; estado: string; detalle: Record<string, unknown> }>(
  `SELECT tipo, estado, detalle FROM revisiones_financieras WHERE referencia = $1`, [pi]);

beforeAll(async () => {
  b = await levantarBase();
  m = await b.crearPersona();
  recep = await b.crearPersona({ rol: 'recepcionista' });
  await b.activar(m, 'premium'); // max_invitados 4
  // Varias reservas por día en las pruebas: sin tope diario ni bloqueo de contiguas.
  await b.db.query(`UPDATE tenants SET stripe_account_id = $2,
    config = jsonb_set(jsonb_set(config, '{reserva,max_sesiones_por_dia}', '20'), '{reserva,permitir_continuas}', 'true') WHERE id = $1`, [b.tenantId, CUENTA]);
  await b.setsExclusivos(false);
  estudio = await b.crearEstudio(); // max_invitados_extra = 4 (default)
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('esquema', () => {
  it('CHECKs ≥ 0 en reservas, tabla con UNIQUE por PI, RLS, inmutabilidad, tipo de revisión nuevo y 01G intacto', async () => {
    const rid = await reservaCon(0, 3, 8);
    await expect(b.db.query('UPDATE reservas SET invitados_count = -1 WHERE id = $1', [rid])).rejects.toThrow(/reservas_invitados_count_no_negativo/);
    await expect(b.db.query('UPDATE reservas SET invitados_extra_pagados = -1 WHERE id = $1', [rid])).rejects.toThrow(/reservas_invitados_extra_pagados_no_negativo/);
    const rls = await b.fila<{ r: boolean }>(`SELECT relrowsecurity AS r FROM pg_class WHERE relname = 'invitados_extra_pagos'`);
    expect(rls.r).toBe(true);
    const tipo = await b.fila<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'revisiones_financieras_tipo_check'`);
    for (const t of ['reembolso', 'disputa_abierta', 'disputa_perdida', 'origen_no_resuelto', 'origen_ambiguo', 'reconciliacion_reembolso', 'cuenta_desautorizada', 'vinculo_valor_pendiente', 'invitados_extra_no_aplicado']) {
      expect(tipo.d).toContain(`'${t}'`);
    }
    const cap = await b.fila<{ c: string }>(`SELECT col_description('recursos'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'recursos'::regclass AND attname = 'capacidad_personas')) AS c`);
    expect(cap.c).toMatch(/INFORMATIVO/);
  });

  it('grants: aplicar y fichas solo service_role; la firma vieja no la ejecuta NADIE de la app (ni service_role)', async () => {
    const priv = async (rol: string, fn: string) =>
      (await b.fila<{ p: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS p`, [rol, fn])).p;
    const aplicarSig = 'aplicar_invitados_extra_pago(text, text, uuid, text, uuid, uuid, integer, integer, integer, text, timestamptz, uuid)';
    const fichaSig = 'registrar_ficha_invitado(uuid, uuid, text, text)';
    const vieja = 'registrar_invitados_extra_pagados(uuid, integer)';
    expect(await priv('service_role', aplicarSig)).toBe(true);
    expect(await priv('authenticated', aplicarSig)).toBe(false);
    expect(await priv('anon', aplicarSig)).toBe(false);
    expect(await priv('service_role', fichaSig)).toBe(true);
    expect(await priv('authenticated', fichaSig)).toBe(false);
    // La vieja sigue existiendo (sin DROP) pero nadie de la app puede llamarla.
    expect((await b.filas(`SELECT 1 FROM pg_proc WHERE proname = 'registrar_invitados_extra_pagados'`)).length).toBe(1);
    for (const rol of ['service_role', 'authenticated', 'anon']) expect(await priv(rol, vieja), rol).toBe(false);
  });

  it('la función toma los locks que la protegen en Postgres real: advisory por PI y luego FOR UPDATE de la reserva', async () => {
    const def = await b.fila<{ d: string }>(`SELECT pg_get_functiondef('aplicar_invitados_extra_pago'::regproc) AS d`);
    const iAdv = def.d.indexOf("pg_advisory_xact_lock(hashtextextended('extras:'");
    const iRow = def.d.indexOf('FROM reservas WHERE id = p_reserva_id FOR UPDATE');
    expect(iAdv).toBeGreaterThan(0);
    expect(iRow).toBeGreaterThan(iAdv);
    const ficha = await b.fila<{ d: string }>(`SELECT pg_get_functiondef('registrar_ficha_invitado'::regproc) AS d`);
    expect(ficha.d).toContain('FROM reservas WHERE id = p_reserva_id FOR UPDATE');
  });
});

describe('aplicación de extras: una vez por PaymentIntent', () => {
  it('primer PI aplica; mismo PI otra vez, por otro evento, tras "reintento" o en paralelo → UNA sola aplicación', async () => {
    const rid = await reservaCon(0, 4);
    const r1 = await aplicar({ pi: 'pi_uno', reserva: rid, cantidad: 2, evento: 'evt_1' });
    expect(r1).toMatchObject({ success: true, estado: 'aplicado', idempotente: false });
    // mismo evento (re-entrega), otro evento del mismo PI, y el reintento tras un fallo posterior
    for (const evento of ['evt_1', 'evt_otro', 'evt_reintento']) {
      expect(await aplicar({ pi: 'pi_uno', reserva: rid, cantidad: 2, evento })).toMatchObject({ estado: 'aplicado', idempotente: true });
    }
    // "en paralelo" (PGlite serializa; en Postgres real lo serializa el advisory lock)
    const par = await Promise.all([1, 2, 3].map(() => aplicar({ pi: 'pi_uno', reserva: rid, cantidad: 2 })));
    expect(par.every((x) => x.idempotente === true)).toBe(true);
    expect(await contador(rid)).toEqual({ c: 2, s: 2 });
    expect(await evidencia('pi_uno')).toEqual([{ estado: 'aplicado', motivo: null }]);
  });

  it('S-1 · aplicado y luego "falla un paso posterior": la re-ejecución del MISMO PI no suma nada', async () => {
    const rid = await reservaCon(0, 5);
    await b.db.exec('BEGIN');
    const r = await aplicar({ pi: 'pi_s1', reserva: rid, cantidad: 3 });
    expect(r.estado).toBe('aplicado');
    await b.db.exec('COMMIT'); // la aplicación quedó; el diario/finalizar del webhook "falla" después
    const reintento = await aplicar({ pi: 'pi_s1', reserva: rid, cantidad: 3, evento: 'evt_retry' });
    expect(reintento).toMatchObject({ estado: 'aplicado', idempotente: true });
    expect(await contador(rid)).toEqual({ c: 3, s: 3 });
  });

  it('dos PI distintos dentro del tope → ambos aplican (contador = SUM)', async () => {
    const rid = await reservaCon(0, 6);
    expect((await aplicar({ pi: 'pi_a1', reserva: rid, cantidad: 1 })).estado).toBe('aplicado');
    expect((await aplicar({ pi: 'pi_a2', reserva: rid, cantidad: 2 })).estado).toBe('aplicado');
    expect(await contador(rid)).toEqual({ c: 3, s: 3 });
  });

  it('3 + 3 contra tope 4 (ambos válidos y creados antes del webhook) → uno aplicado=3, otro no_aplicado/excede_tope, nunca 6, UNA revisión', async () => {
    const rid = await reservaCon(0, 7);
    const [a, bb] = await Promise.all([
      aplicar({ pi: 'pi_tope_a', reserva: rid, cantidad: 3 }),
      aplicar({ pi: 'pi_tope_b', reserva: rid, cantidad: 3 })
    ]);
    const estados = [a.estado, bb.estado].sort();
    expect(estados).toEqual(['aplicado', 'no_aplicado']);
    const rechazado = a.estado === 'no_aplicado' ? 'pi_tope_a' : 'pi_tope_b';
    expect(await evidencia(rechazado)).toEqual([{ estado: 'no_aplicado', motivo: 'excede_tope' }]);
    expect(await contador(rid)).toEqual({ c: 3, s: 3 });
    const revs = await revisionesDe(rechazado);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ tipo: 'invitados_extra_no_aplicado', estado: 'abierta' });
    expect(revs[0].detalle).toMatchObject({ reserva_id: rid, stripe_payment_intent_id: rechazado, cantidad: 3, monto_centavos: 30000, motivo: 'excede_tope' });
    // El mismo PI rechazado vuelve a llegar: sigue no_aplicado (resultado FINAL) y no hay otra revisión.
    expect(await aplicar({ pi: rechazado, reserva: rid, cantidad: 3 })).toMatchObject({ estado: 'no_aplicado', motivo: 'excede_tope', idempotente: true });
    expect(await revisionesDe(rechazado)).toHaveLength(1);
  });
});

describe('aplicación inválida → no_aplicado + revisión, CERO mutación de derechos', () => {
  const estadoNegocio = () =>
    b.fila<{ h: string }>(`SELECT md5(string_agg(concat_ws('|', id, status, invitados_count, invitados_extra_pagados), ',' ORDER BY id)) AS h FROM reservas`);

  it('cancelada, cancelada_admin y no_show → reserva_no_aplicable; completada en curso → aplica', async () => {
    for (const st of ['cancelada', 'cancelada_admin', 'no_show']) {
      const rid = await reservaCon(0, 8, st === 'cancelada' ? 9 : st === 'cancelada_admin' ? 11 : 13);
      await b.db.query(`UPDATE reservas SET status = $2 WHERE id = $1`, [rid, st]);
      const antes = await estadoNegocio();
      const pi = `pi_st_${st}`;
      expect(await aplicar({ pi, reserva: rid })).toMatchObject({ estado: 'no_aplicado', motivo: 'reserva_no_aplicable' });
      expect(await contador(rid)).toEqual({ c: 0, s: 0 });
      expect(await revisionesDe(pi)).toHaveLength(1);
      expect(await estadoNegocio()).toEqual(antes);
    }
    const rid = await reservaCon(0, 9);
    await b.db.query(`UPDATE reservas SET status = 'completada', check_in_at = now() WHERE id = $1`, [rid]);
    expect((await aplicar({ pi: 'pi_completada', reserva: rid })).estado).toBe('aplicado');
  });

  it('pagado después del fin de la sesión (slot_fin) → reserva_pasada; el tiempo es el del PAGO, no el de llegada del webhook', async () => {
    const rid = await reservaCon(0, 10);
    const fin = await b.fila<{ f: string }>('SELECT slot_fin::text AS f FROM reservas WHERE id = $1', [rid]);
    const despues = new Date(new Date(fin.f).getTime() + 60_000).toISOString();
    const antes = new Date(new Date(fin.f).getTime() - 60_000).toISOString();
    expect(await aplicar({ pi: 'pi_tarde', reserva: rid, pagadoAt: despues })).toMatchObject({ estado: 'no_aplicado', motivo: 'reserva_pasada' });
    // Un pago hecho DENTRO de la sesión es válido aunque el webhook se procese después.
    expect((await aplicar({ pi: 'pi_a_tiempo', reserva: rid, pagadoAt: antes })).estado).toBe('aplicado');
  });

  it('tenant, cuenta Stripe, usuario o tenant de metadata incompatibles → tenant_incompatible', async () => {
    const rid = await reservaCon(0, 11);
    const otro = await b.crearPersona();
    expect((await aplicar({ pi: 'pi_cta', reserva: rid, cuenta: 'acct_ajena' })).motivo).toBe('tenant_incompatible');
    expect((await aplicar({ pi: 'pi_usr', reserva: rid, usuario: otro.id })).motivo).toBe('tenant_incompatible');
    expect((await aplicar({ pi: 'pi_meta', reserva: rid, tenantMeta: randomUUID() })).motivo).toBe('tenant_incompatible');
    const t2 = await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, vertical, stripe_account_id) VALUES ('otro-h', 'Otro', 'estudio', 'acct_otro_h') RETURNING id`);
    expect((await aplicar({ pi: 'pi_ten', reserva: rid, tenant: t2.id, cuenta: 'acct_otro_h' })).motivo).toBe('tenant_incompatible');
    expect(await contador(rid)).toEqual({ c: 0, s: 0 });
  });

  it('monto ≠ cantidad × snapshot, moneda distinta, o sin snapshot → monto_no_coincide / sin_snapshot_precio', async () => {
    const rid = await reservaCon(0, 12);
    expect((await aplicar({ pi: 'pi_monto', reserva: rid, cantidad: 2, monto: 15000, precio: 10000 })).motivo).toBe('monto_no_coincide');
    expect((await aplicar({ pi: 'pi_usd', reserva: rid, cantidad: 1, precio: 10000, moneda: 'usd' })).motivo).toBe('monto_no_coincide');
    expect((await aplicar({ pi: 'pi_sin', reserva: rid, cantidad: 1, monto: 10000, precio: null })).motivo).toBe('sin_snapshot_precio');
    // El snapshot manda, no la config actual: con precio snapshot 7000 y monto 7000 aplica aunque la config diga 10000.
    expect((await aplicar({ pi: 'pi_snap', reserva: rid, cantidad: 1, precio: 7000 })).estado).toBe('aplicado');
  });

  it('contador manipulado por fuera (residual 01L) → no suma sobre él: contador_inconsistente + revisión, sin reparar', async () => {
    const rid = await reservaCon(0, 13);
    await aplicar({ pi: 'pi_ok', reserva: rid, cantidad: 1 });
    await b.db.query('UPDATE reservas SET invitados_extra_pagados = 4 WHERE id = $1', [rid]); // "admin por REST"
    expect(await aplicar({ pi: 'pi_tras_manipular', reserva: rid, cantidad: 1 })).toMatchObject({ estado: 'no_aplicado', motivo: 'contador_inconsistente' });
    expect(await contador(rid)).toEqual({ c: 4, s: 1 }); // no se "repara" solo
    expect(await revisionesDe('pi_tras_manipular')).toHaveLength(1);
  });

  it('la evidencia es inmutable: ni UPDATE ni DELETE', async () => {
    await expect(b.db.query(`UPDATE invitados_extra_pagos SET estado = 'aplicado', motivo = NULL WHERE stripe_payment_intent_id = 'pi_sin'`)).rejects.toThrow(/EKKO_EXTRAS_INMUTABLE/);
    await expect(b.db.query(`DELETE FROM invitados_extra_pagos WHERE stripe_payment_intent_id = 'pi_uno'`)).rejects.toThrow(/EKKO_EXTRAS_INMUTABLE/);
  });

  it('RLS: el admin del tenant lee la evidencia; un miembro no', async () => {
    const admin = await b.crearPersona({ rol: 'admin' });
    expect((await b.como(admin, () => b.filas('SELECT id FROM invitados_extra_pagos'))).length).toBeGreaterThan(0);
    expect((await b.como(m, () => b.filas('SELECT id FROM invitados_extra_pagos'))).length).toBe(0);
    await expect(b.como(admin, () => b.fila(`SELECT aplicar_invitados_extra_pago('pi_x', 'a', $1, 'e', $2, $3, 1, 100, 100, 'mxn', now())`, [b.tenantId, randomUUID(), m.id]))).rejects.toThrow();
  });

  it('reserva inexistente → success:false (sin fila huérfana)', async () => {
    const r = await aplicar({ pi: 'pi_nada', reserva: randomUUID() });
    expect(r).toMatchObject({ success: false, reason: 'reserva_no_encontrada' });
    expect(await evidencia('pi_nada')).toEqual([]);
  });

  it('las revisiones 01G existentes siguen siendo válidas con el CHECK extendido', async () => {
    for (const tipo of ['reembolso', 'cuenta_desautorizada']) {
      await b.db.query(`INSERT INTO revisiones_financieras (tenant_id, tipo, referencia) VALUES ($1, $2, $3)`, [b.tenantId, tipo, `ref_${tipo}`]);
    }
    await expect(b.db.query(`INSERT INTO revisiones_financieras (tenant_id, tipo, referencia) VALUES ($1, 'inventado', 'x')`, [b.tenantId])).rejects.toThrow(/revisiones_financieras_tipo_check/);
  });
});

describe('fichas de recepción (W-3=A)', () => {
  const ficha = (reserva: string, nombre = 'Invitado Uno', actor = recep.id) =>
    b.fila<{ r: { es_extra: boolean; registrados: number; cubiertos: number } }>('SELECT registrar_ficha_invitado($1, $2, $3) AS r', [actor, reserva, nombre]).then((x) => x.r);

  it('incluidos primero, luego extras pagados, y cubiertos + 1 rechazado; es_extra sale de la reserva', async () => {
    const rid = await reservaCon(2, 14); // 2 incluidos
    await aplicar({ pi: 'pi_fichas', reserva: rid, cantidad: 1 }); // + 1 extra pagado
    const f1 = await ficha(rid, 'Uno');
    const f2 = await ficha(rid, 'Dos');
    const f3 = await ficha(rid, 'Tres');
    expect([f1.es_extra, f2.es_extra, f3.es_extra]).toEqual([false, false, true]);
    expect(f3).toMatchObject({ registrados: 3, cubiertos: 3 });
    await expect(ficha(rid, 'Cuatro')).rejects.toThrow(/EKKO_INVITADOS_NO_CUBIERTOS/);
  });

  it('el plan cacheado del miembro es irrelevante: cambiarlo no altera lo cubierto ni es_extra', async () => {
    const rid = await reservaCon(1, 15);
    await b.db.query(`UPDATE usuarios SET membresia_tier = 'esencial' WHERE id = $1`, [m.id]);
    expect((await ficha(rid, 'Solo')).es_extra).toBe(false);
    await expect(ficha(rid, 'Otro')).rejects.toThrow(/EKKO_INVITADOS_NO_CUBIERTOS/);
    await b.db.query(`UPDATE usuarios SET membresia_tier = 'premium' WHERE id = $1`, [m.id]);
  });

  it('reserva cancelada o fuera de la ventana de asistencia (slot_fin + 60 min) → rechazada', async () => {
    const rid = await reservaCon(2, 16);
    await b.db.query(`UPDATE reservas SET status = 'cancelada' WHERE id = $1`, [rid]);
    await expect(ficha(rid)).rejects.toThrow(/EKKO_RESERVA_NO_VIGENTE/);
    const rid2 = await reservaCon(2, 17);
    await b.db.query(`ALTER TABLE reservas DISABLE TRIGGER USER`);
    await b.db.query(`UPDATE reservas SET slot_inicio = now() - interval '4 hours', slot_fin = now() - interval '150 minutes' WHERE id = $1`, [rid2]);
    await b.db.query(`ALTER TABLE reservas ENABLE TRIGGER USER`);
    await expect(ficha(rid2)).rejects.toThrow(/EKKO_RESERVA_PASADA/);
  });

  it('staff de otro estudio, miembro o staff inactivo → rechazado', async () => {
    const rid = await reservaCon(2, 18);
    const t2 = await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, vertical) VALUES ('otro-h2', 'Otro', 'estudio') RETURNING id`);
    const ajeno = await b.crearPersona({ rol: 'recepcionista' });
    await b.db.query('UPDATE usuarios SET tenant_id = $2 WHERE id = $1', [ajeno.id, t2.id]);
    await expect(ficha(rid, 'Equis', ajeno.id)).rejects.toThrow(/EKKO_TENANT_DIFERENTE/);
    await expect(ficha(rid, 'Equis', m.id)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    const inactivo = await b.crearPersona({ rol: 'recepcionista', status: 'revocado' });
    await expect(ficha(rid, 'Equis', inactivo.id)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });

  it('dos altas "simultáneas" por el último lugar → entra una (lock de la reserva)', async () => {
    const rid = await reservaCon(1, 19);
    const res = await Promise.allSettled([ficha(rid, 'Ana'), ficha(rid, 'Beto')]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect((await b.fila<{ n: number }>('SELECT COUNT(*)::int AS n FROM reserva_invitados WHERE reserva_id = $1', [rid])).n).toBe(1);
  });
});

describe('sin backfill', () => {
  it('la migración no reescribe datos: sin UPDATE/DELETE de negocio ni funciones cerradas', async () => {
    const sql = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../../../supabase/migrations/20261003100000_invitados_extra_integridad.sql'), 'utf8'
    ).replace(/^\s*--.*$/gm, '');
    // Los únicos UPDATE están dentro del cuerpo de la RPC (el contador derivado).
    const fueraDeFunciones = sql.replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(fueraDeFunciones).not.toMatch(/\bUPDATE\s+(reservas|membresias|usuarios|payment_events|reserva_invitados)\b/i);
    expect(fueraDeFunciones).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(fueraDeFunciones).not.toMatch(/DROP\s+(TABLE|FUNCTION|COLUMN)/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION (activar_membresia|sync_membresia_stripe|claim_stripe_event|registrar_venta_mostrador|cambiar_tier_membresia|reservas_incompatibles_con_tier|staff_ajustar_creditos|staff_cancelar_membresia|resolver_revision_financiera|registrar_reversal_pago)\b/);
  });
});
