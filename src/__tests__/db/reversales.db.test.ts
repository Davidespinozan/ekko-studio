// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-01G · migración 20261002100000 contra un Postgres real (PGlite).
 *
 * Invariantes:
 *   EVERY STRIPE REVERSAL MUST LEAVE DURABLE, IDENTITY-KEYED, IDEMPOTENT FINANCIAL EVIDENCE.
 *   REVERSAL OF PAYMENT X MUST NOT MUTATE ENTITLEMENT Y UNLESS X PROVABLY FUNDED Y.
 *   AMBIGUOUS FINANCIAL REVERSAL → DURABLE REVIEW, NOT GUESSED ENTITLEMENT MUTATION.
 *   CONNECT ACCOUNT LIFECYCLE AFFECTS THE STUDIO'S ABILITY TO CHARGE, NEVER A MEMBER'S ENTITLEMENT.
 *
 * Aquí se prueba la capa de base: identidad por objeto, montos exactos, orden,
 * atribución (único/ninguno/ambiguo), revisiones, proveniencia, Connect. Lo que
 * NO ocurre en ningún caso: cambios en membresias/creditos/usuarios/reservas.
 */

let b: BaseDePrueba;
let m: Persona;
let admin: Persona;
let recep: Persona;

type Reversal = {
  id: string; tipo: string; stripe_object_id: string; monto_centavos: number; estado_proveedor: string;
  pago_origen_id: string | null; membresia_origen_id: string | null; usuario_id: string | null; ultimo_stripe_event_id: string;
};
type Revision = { id: string; tipo: string; estado: string; resolucion: string | null; reversal_id: string | null; referencia: string | null; actor_rol: string | null; reabierta_at: string | null };

const T0 = '2026-10-02T10:00:00Z';
const t = (min: number) => new Date(new Date(T0).getTime() + min * 60_000).toISOString();

async function pagoSucceeded(pi: string, opts: { usuario?: string | null; membresia?: string | null; evento?: string; tenant?: string | null } = {}) {
  const r = await b.fila<{ id: string }>(
    `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, stripe_payment_intent_id, usuario_id, membresia_id, monto_centavos, moneda, status, raw_payload)
     VALUES ($1, $2, 'payment_intent.succeeded', $3, $4, $5, 85000, 'mxn', 'succeeded', '{}'::jsonb) RETURNING id`,
    [opts.tenant === undefined ? b.tenantId : opts.tenant, opts.evento ?? `evt_pago_${pi}_${randomUUID().slice(0, 8)}`, pi, opts.usuario ?? m.id, opts.membresia ?? null]
  );
  return r.id;
}

async function registrar(o: {
  tipo?: 'reembolso' | 'disputa'; id: string; charge?: string; pi?: string | null; monto?: number; estado?: string; evento?: string; at?: string; tenant?: string;
}) {
  const r = await b.fila<{ r: Record<string, unknown> }>(
    `SELECT registrar_reversal_pago($1, $2, $3, $4, 'acct_test', $5, $6, 'mxn', $7, NULL, $8::timestamptz, $9::timestamptz, $10, '{}'::jsonb) AS r`,
    [o.tipo ?? 'reembolso', o.id, o.charge ?? 'ch_1', o.pi === undefined ? 'pi_1' : o.pi, o.tenant ?? b.tenantId, o.monto ?? 10000,
     o.estado ?? (o.tipo === 'disputa' ? 'needs_response' : 'succeeded'), o.at ?? T0, o.at ?? T0, o.evento ?? `evt_${o.id}_${randomUUID().slice(0, 8)}`]
  );
  return r.r;
}
const reversal = (objId: string) => b.fila<Reversal>('SELECT * FROM reversales_pago WHERE stripe_object_id = $1', [objId]);
const revisiones = (where = '', params: unknown[] = []) =>
  b.filas<Revision>(`SELECT * FROM revisiones_financieras ${where ? 'WHERE ' + where : ''} ORDER BY abierta_at, id`, params);
const estadoNegocio = async () =>
  b.fila<{ membresias: string; creditos: string | null; usuarios: string; reservas: string; mov: string }>(
    `SELECT (SELECT md5(string_agg(m::text, '|' ORDER BY m.id)) FROM membresias m) AS membresias,
            (SELECT SUM(creditos_restantes)::text FROM membresias) AS creditos,
            (SELECT md5(string_agg(u.status || u.id::text, '|' ORDER BY u.id)) FROM usuarios u) AS usuarios,
            (SELECT md5(COALESCE(string_agg(r::text, '|' ORDER BY r.id), '')) FROM reservas r) AS reservas,
            (SELECT COUNT(*)::text FROM membresia_movimientos) AS mov`
  );

beforeAll(async () => {
  b = await levantarBase();
  m = await b.crearPersona();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  await b.activar(m, 'creador'); // paquete con créditos: hay derecho vivo que NO debe moverse
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('reembolsos: identidad, monto exacto, idempotencia y orden', () => {
  it('un parcial de 100: una fila re_, monto 100, origen único enlazado, UNA revisión', async () => {
    const antes = await estadoNegocio();
    const mem = await b.fila<{ id: string }>('SELECT id FROM membresias WHERE usuario_id = $1 ORDER BY created_at DESC LIMIT 1', [m.id]);
    const pago = await pagoSucceeded('pi_1', { membresia: mem.id });
    const r = await registrar({ id: 're_1', monto: 10000 });
    expect(r).toMatchObject({ success: true, nuevo: true, origen: 'unico', pago_origen_id: pago, membresia_origen_id: mem.id, usuario_id: m.id });
    const fila = await reversal('re_1');
    expect(fila).toMatchObject({ tipo: 'reembolso', monto_centavos: 10000, estado_proveedor: 'succeeded', pago_origen_id: pago, membresia_origen_id: mem.id });
    const revs = await revisiones('reversal_id = $1', [fila.id]);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ tipo: 'reembolso', estado: 'abierta' });
    // CERO mutación de derechos.
    expect(await estadoNegocio()).toEqual(antes);
  });

  it('dos parciales (100 + 50) son dos objetos: la suma es 150, nunca el acumulado 250', async () => {
    await registrar({ id: 're_2', monto: 5000 });
    const suma = await b.fila<{ s: number }>(`SELECT SUM(monto_centavos)::int AS s FROM reversales_pago WHERE stripe_charge_id = 'ch_1' AND estado_proveedor = 'succeeded'`);
    expect(suma.s).toBe(15000);
    expect((await revisiones(`reversal_id IN (SELECT id FROM reversales_pago WHERE stripe_charge_id = 'ch_1')`)).length).toBe(2);
  });

  it('el mismo objeto por un evento DISTINTO (re-entrega) no crea otra fila ni otra revisión', async () => {
    const r = await registrar({ id: 're_1', monto: 10000, evento: 'evt_otro_id', at: t(-5) });
    expect(r).toMatchObject({ nuevo: false, idempotente: true });
    expect((await b.filas(`SELECT 1 FROM reversales_pago WHERE stripe_object_id = 're_1'`)).length).toBe(1);
    expect((await revisiones(`reversal_id = (SELECT id FROM reversales_pago WHERE stripe_object_id = 're_1')`)).length).toBe(1);
  });

  it('mismo objeto con monto distinto → EKKO_REVERSAL_CONFLICTO (la identidad manda)', async () => {
    await expect(registrar({ id: 're_1', monto: 99999, at: t(10) })).rejects.toThrow(/EKKO_REVERSAL_CONFLICTO/);
  });

  it('fuera de orden: updated(succeeded, t+2) antes que created(pending, t+1) → queda succeeded', async () => {
    await registrar({ id: 're_3', monto: 1000, estado: 'succeeded', at: t(2), evento: 'evt_re3_upd' });
    const r = await registrar({ id: 're_3', monto: 1000, estado: 'pending', at: t(1), evento: 'evt_re3_cre' });
    expect(r).toMatchObject({ idempotente: true });
    expect((await reversal('re_3')).estado_proveedor).toBe('succeeded');
    // Y un evento más nuevo sí avanza (failed).
    await registrar({ id: 're_3', monto: 1000, estado: 'failed', at: t(3), evento: 'evt_re3_fail' });
    expect((await reversal('re_3')).estado_proveedor).toBe('failed');
  });

  it('la evidencia es inmutable: no se borra ni se cambia monto/identidad; el origen no se reasigna', async () => {
    await expect(b.db.query(`DELETE FROM reversales_pago WHERE stripe_object_id = 're_1'`)).rejects.toThrow(/EKKO_REVERSAL_INMUTABLE/);
    await expect(b.db.query(`UPDATE reversales_pago SET monto_centavos = 1 WHERE stripe_object_id = 're_1'`)).rejects.toThrow(/EKKO_REVERSAL_INMUTABLE/);
    await expect(b.db.query(`UPDATE reversales_pago SET pago_origen_id = NULL WHERE stripe_object_id = 're_1'`)).rejects.toThrow(/EKKO_REVERSAL_INMUTABLE/);
  });
});

describe('atribución del origen (HARDENING A) y vínculo tardío (HARDENING B)', () => {
  it('sin pago exitoso aún (reembolso antes del succeeded tardío): fila sin origen + revisión origen_no_resuelto', async () => {
    const r = await registrar({ id: 're_tarde', pi: 'pi_tarde', charge: 'ch_tarde', monto: 2000 });
    expect(r).toMatchObject({ origen: 'ninguno' });
    expect((await reversal('re_tarde')).pago_origen_id).toBeNull();
    const rev = await revisiones(`tipo = 'origen_no_resuelto' AND referencia = 're_tarde'`);
    expect(rev).toHaveLength(1);
    expect(rev[0].estado).toBe('abierta');
  });

  it('…cuando llega el pago, reatribuir_reversales enlaza el origen y cierra la revisión (idempotente)', async () => {
    const pago = await pagoSucceeded('pi_tarde');
    const r1 = await b.fila<{ r: { reatribuidos: number } }>(`SELECT reatribuir_reversales('pi_tarde') AS r`);
    expect(r1.r.reatribuidos).toBe(1);
    expect((await reversal('re_tarde')).pago_origen_id).toBe(pago);
    const rev = await revisiones(`tipo = 'origen_no_resuelto' AND referencia = 're_tarde'`);
    expect(rev[0]).toMatchObject({ estado: 'resuelta', resolucion: 'reconciliado', actor_rol: 'sistema' });
    const r2 = await b.fila<{ r: { reatribuidos: number } }>(`SELECT reatribuir_reversales('pi_tarde') AS r`);
    expect(r2.r.reatribuidos).toBe(0);
  });

  it('origen ambiguo (dos pagos exitosos incompatibles para el mismo PI): no se enlaza nada, revisión origen_ambiguo', async () => {
    const otro = await b.crearPersona();
    await pagoSucceeded('pi_amb', { usuario: m.id });
    await pagoSucceeded('pi_amb', { usuario: otro.id });
    const r = await registrar({ id: 're_amb', pi: 'pi_amb', charge: 'ch_amb', monto: 3000 });
    expect(r).toMatchObject({ origen: 'ambiguo' });
    expect((await reversal('re_amb'))).toMatchObject({ pago_origen_id: null, usuario_id: null, membresia_origen_id: null });
    expect((await revisiones(`tipo = 'origen_ambiguo' AND referencia = 're_amb'`)).length).toBe(1);
    // reatribuir tampoco adivina.
    const r2 = await b.fila<{ r: { reatribuidos: number; candidatos: number } }>(`SELECT reatribuir_reversales('pi_amb') AS r`);
    expect(r2.r).toMatchObject({ reatribuidos: 0, candidatos: 2 });
  });

  it('el pago de origen de OTRO estudio no se enlaza (tenant de la cuenta manda)', async () => {
    const t2 = await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, vertical) VALUES ('otro-g', 'Otro', 'estudio') RETURNING id`);
    await pagoSucceeded('pi_t2', { tenant: t2.id, usuario: null });
    const r = await registrar({ id: 're_t2', pi: 'pi_t2', charge: 'ch_t2', monto: 100 });
    expect(r).toMatchObject({ origen: 'ambiguo' });
    expect((await reversal('re_t2')).pago_origen_id).toBeNull();
  });

  it('sin tenant → EKKO_REVERSAL_SIN_TENANT (nunca una fila huérfana invisible)', async () => {
    await expect(
      b.fila(`SELECT registrar_reversal_pago('reembolso', 're_x', 'ch_x', NULL, NULL, NULL, 100, 'mxn', 'succeeded', NULL, NULL, now(), 'evt_x', '{}'::jsonb)`)
    ).rejects.toThrow(/EKKO_REVERSAL_SIN_TENANT/);
  });
});

describe('charge.refunded = reconciliación, nunca monto', () => {
  it('acumulado que cuadra con los Refund succeeded → sin revisión; que no cuadra → revisión con lo esperado', async () => {
    const ok = await b.fila<{ r: { cuadra: boolean; suma_centavos: number } }>(`SELECT reconciliar_reembolsos_cargo($1, 'ch_1', 15000, 'evt_chr_1') AS r`, [b.tenantId]);
    expect(ok.r).toMatchObject({ cuadra: true, suma_centavos: 15000 });
    expect((await revisiones(`tipo = 'reconciliacion_reembolso' AND referencia = 'ch_1'`)).length).toBe(0);

    // Llega charge.refunded ANTES que el refund.created correspondiente (orden no garantizado).
    const no = await b.fila<{ r: { cuadra: boolean } }>(`SELECT reconciliar_reembolsos_cargo($1, 'ch_9', 7000, 'evt_chr_9') AS r`, [b.tenantId]);
    expect(no.r.cuadra).toBe(false);
    let rev = await revisiones(`tipo = 'reconciliacion_reembolso' AND referencia = 'ch_9'`);
    expect(rev).toHaveLength(1);
    expect(rev[0].estado).toBe('abierta');
    // Un segundo charge.refunded igual no duplica la revisión.
    await b.fila(`SELECT reconciliar_reembolsos_cargo($1, 'ch_9', 7000, 'evt_chr_9b')`, [b.tenantId]);
    expect((await revisiones(`tipo = 'reconciliacion_reembolso' AND referencia = 'ch_9'`)).length).toBe(1);
    // Cuando llega el Refund, cuadra y se cierra sola.
    await registrar({ id: 're_9', charge: 'ch_9', pi: 'pi_9', monto: 7000 });
    rev = await revisiones(`tipo = 'reconciliacion_reembolso' AND referencia = 'ch_9'`);
    expect(rev[0]).toMatchObject({ estado: 'resuelta', resolucion: 'reconciliado' });
    // La suma sigue siendo por objetos: 7000, no 7000 + acumulado.
    const suma = await b.fila<{ s: number }>(`SELECT SUM(monto_centavos)::int AS s FROM reversales_pago WHERE stripe_charge_id = 'ch_9'`);
    expect(suma.s).toBe(7000);
  });
});

describe('disputas: created / updated / won / lost, duplicados y orden', () => {
  it('created → fila dp_ + revisión disputa_abierta; updated no avisa ni duplica', async () => {
    const antes = await estadoNegocio();
    const r = await registrar({ tipo: 'disputa', id: 'dp_1', monto: 85000, estado: 'needs_response', at: t(0) });
    expect(r).toMatchObject({ nuevo: true });
    await registrar({ tipo: 'disputa', id: 'dp_1', monto: 85000, estado: 'under_review', at: t(1) });
    expect((await reversal('dp_1')).estado_proveedor).toBe('under_review');
    const rev = await revisiones(`reversal_id = (SELECT id FROM reversales_pago WHERE stripe_object_id = 'dp_1')`);
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ tipo: 'disputa_abierta', estado: 'abierta' });
    expect(await estadoNegocio()).toEqual(antes);
  });

  it('won → la revisión se resuelve sola (disputa_ganada, actor sistema); un duplicado viejo no la reabre', async () => {
    await registrar({ tipo: 'disputa', id: 'dp_1', monto: 85000, estado: 'won', at: t(5) });
    let rev = await revisiones(`reversal_id = (SELECT id FROM reversales_pago WHERE stripe_object_id = 'dp_1')`);
    expect(rev[0]).toMatchObject({ estado: 'resuelta', resolucion: 'disputa_ganada', actor_rol: 'sistema' });
    await registrar({ tipo: 'disputa', id: 'dp_1', monto: 85000, estado: 'needs_response', at: t(0), evento: 'evt_dp1_viejo' });
    rev = await revisiones(`reversal_id = (SELECT id FROM reversales_pago WHERE stripe_object_id = 'dp_1')`);
    expect(rev[0].estado).toBe('resuelta');
    expect((await reversal('dp_1')).estado_proveedor).toBe('won');
  });

  it('lost → revisión abierta como disputa_perdida (política D7: humano decide); funds_withdrawn solo actualiza estado', async () => {
    const antes = await estadoNegocio();
    await registrar({ tipo: 'disputa', id: 'dp_2', charge: 'ch_2', pi: 'pi_1', monto: 85000, estado: 'needs_response', at: t(0) });
    await registrar({ tipo: 'disputa', id: 'dp_2', charge: 'ch_2', pi: 'pi_1', monto: 85000, estado: 'lost', at: t(3) });
    const rev = await revisiones(`reversal_id = (SELECT id FROM reversales_pago WHERE stripe_object_id = 'dp_2')`);
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ tipo: 'disputa_perdida', estado: 'abierta' });
    expect(await estadoNegocio()).toEqual(antes);
  });

  it('won y luego lost (raro) → se reabre como disputa_perdida con reabierta_at', async () => {
    await registrar({ tipo: 'disputa', id: 'dp_3', charge: 'ch_3', pi: null, monto: 500, estado: 'won', at: t(0) });
    await registrar({ tipo: 'disputa', id: 'dp_3', charge: 'ch_3', pi: null, monto: 500, estado: 'lost', at: t(4) });
    const rev = await revisiones(`reversal_id = (SELECT id FROM reversales_pago WHERE stripe_object_id = 'dp_3')`);
    expect(rev[0]).toMatchObject({ tipo: 'disputa_perdida', estado: 'abierta' });
    expect(rev[0].reabierta_at).not.toBeNull();
  });

  it('un objeto dp_ no puede registrarse como reembolso ni con estados de reembolso (CHECKs)', async () => {
    await expect(registrar({ tipo: 'reembolso', id: 'dp_malo', monto: 1 })).rejects.toThrow(/reversales_pago_objeto_tipo_check/);
    await expect(registrar({ tipo: 'disputa', id: 'dp_malo', monto: 1, estado: 'succeeded' })).rejects.toThrow(/reversales_pago_estado_check/);
  });
});

describe('revisión humana: documenta, NO muta derechos', () => {
  it('recepción no puede resolver; admin sí, con nota ≥ 10; idempotente con la misma resolución; audit_log', async () => {
    const rev = (await revisiones(`tipo = 'reembolso' AND estado = 'abierta'`))[0];
    await expect(b.como(recep, () => b.fila(`SELECT resolver_revision_financiera($1, 'sin_efecto', 'Revisado con el miembro')`, [rev.id]))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(b.como(admin, () => b.fila(`SELECT resolver_revision_financiera($1, 'sin_efecto', 'corto')`, [rev.id]))).rejects.toThrow(/EKKO_NOTA_REQUERIDA/);
    await expect(b.como(admin, () => b.fila(`SELECT resolver_revision_financiera($1, 'disputa_ganada', 'Intento de usar resolución del sistema')`, [rev.id]))).rejects.toThrow(/EKKO_RESOLUCION_INVALIDA/);

    const antes = await estadoNegocio();
    const r = await b.como(admin, () => b.fila<{ r: { success: boolean; idempotente: boolean } }>(`SELECT resolver_revision_financiera($1, 'sin_efecto', 'Revisado con el miembro, sin efecto') AS r`, [rev.id]));
    expect(r.r).toMatchObject({ success: true, idempotente: false });
    const fila = (await revisiones('id = $1', [rev.id]))[0];
    expect(fila).toMatchObject({ estado: 'resuelta', resolucion: 'sin_efecto', actor_rol: 'admin' });
    const audit = await b.filas<{ accion: string; actor_usuario_id: string }>(`SELECT accion, actor_usuario_id FROM audit_log WHERE accion = 'revision_financiera_resuelta' AND target_id = $1`, [rev.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_usuario_id).toBe(admin.id);
    expect(await estadoNegocio()).toEqual(antes); // ningún RPC de membresía/créditos se invocó

    const r2 = await b.como(admin, () => b.fila<{ r: { idempotente: boolean } }>(`SELECT resolver_revision_financiera($1, 'sin_efecto', 'Revisado con el miembro, sin efecto') AS r`, [rev.id]));
    expect(r2.r.idempotente).toBe(true);
    await expect(b.como(admin, () => b.fila(`SELECT resolver_revision_financiera($1, 'otro', 'Cambio de opinión posterior')`, [rev.id]))).rejects.toThrow(/EKKO_REVISION_RESUELTA/);
  });

  it('RLS: el admin del tenant lee reversales y revisiones; un miembro no ve nada; nadie escribe por REST', async () => {
    const vistas = await b.como(admin, () => b.filas(`SELECT id FROM reversales_pago`));
    expect(vistas.length).toBeGreaterThan(0);
    expect((await b.como(m, () => b.filas(`SELECT id FROM reversales_pago`))).length).toBe(0);
    expect((await b.como(m, () => b.filas(`SELECT id FROM revisiones_financieras`))).length).toBe(0);
    await expect(b.como(admin, () => b.fila(`INSERT INTO revisiones_financieras (tenant_id, tipo, referencia) VALUES ($1, 'otro', 'x')`, [b.tenantId]))).rejects.toThrow();
  });
});

describe('Connect: desautorización', () => {
  it('apaga el gate, conserva stripe_account_id, deja audit + revisión; idempotente; sin tocar membresías', async () => {
    await b.db.query(`UPDATE tenants SET stripe_account_id = 'acct_ekko', stripe_charges_enabled = true, stripe_details_submitted = true WHERE id = $1`, [b.tenantId]);
    const antes = await estadoNegocio();
    const r = await b.fila<{ r: { success: boolean; idempotente: boolean } }>(`SELECT marcar_cuenta_desautorizada('acct_ekko', 'evt_deauth', $1::timestamptz) AS r`, [T0]);
    expect(r.r).toMatchObject({ success: true, idempotente: false });
    const t1 = await b.fila<{ stripe_account_id: string; stripe_charges_enabled: boolean; stripe_desconectado_at: string | null }>(
      `SELECT stripe_account_id, stripe_charges_enabled, stripe_desconectado_at FROM tenants WHERE id = $1`, [b.tenantId]);
    expect(t1).toMatchObject({ stripe_account_id: 'acct_ekko', stripe_charges_enabled: false });
    expect(t1.stripe_desconectado_at).not.toBeNull();
    expect((await revisiones(`tipo = 'cuenta_desautorizada' AND referencia = 'acct_ekko'`)).length).toBe(1);
    expect((await b.filas(`SELECT 1 FROM audit_log WHERE accion = 'stripe_cuenta_desautorizada'`)).length).toBe(1);
    const r2 = await b.fila<{ r: { idempotente: boolean } }>(`SELECT marcar_cuenta_desautorizada('acct_ekko', 'evt_deauth_2', now()) AS r`);
    expect(r2.r.idempotente).toBe(true);
    expect((await revisiones(`tipo = 'cuenta_desautorizada'`)).length).toBe(1);
    expect(await estadoNegocio()).toEqual(antes);
    const no = await b.fila<{ r: { success: boolean; reason: string } }>(`SELECT marcar_cuenta_desautorizada('acct_nadie', 'evt_z', now()) AS r`);
    expect(no.r).toMatchObject({ success: false, reason: 'cuenta_no_encontrada' });
  });
});

describe('proveniencia del valor (D-01G-4): clasificación al nacer, histórico desconocido, write-once', () => {
  it('compra Stripe: alta → compra_stripe; vincular_origen_valor enlaza el pago una sola vez', async () => {
    const p = await b.crearPersona();
    const act = await b.fila<{ r: { membresia_id: string } }>(
      `SELECT activar_membresia($1, $2, NULL, 'cus_x', NULL, 'pi_prov_1') AS r`, [p.id, await b.tierId('creador')]);
    const mov = await b.filas<{ tipo: string; origen: string; origen_payment_event_id: string | null }>(
      `SELECT tipo, origen, origen_payment_event_id FROM membresia_movimientos WHERE membresia_id = $1 ORDER BY created_at, id`, [act.r.membresia_id]);
    expect(mov.find((x) => x.tipo === 'alta')).toMatchObject({ origen: 'compra_stripe', origen_payment_event_id: null });
    const pago = await pagoSucceeded('pi_prov_1', { usuario: p.id, membresia: act.r.membresia_id });
    const v = await b.fila<{ r: { vinculados: number } }>(`SELECT vincular_origen_valor($1, $2) AS r`, [act.r.membresia_id, pago]);
    expect(v.r.vinculados).toBe(1);
    const v2 = await b.fila<{ r: { vinculados: number } }>(`SELECT vincular_origen_valor($1, $2) AS r`, [act.r.membresia_id, pago]);
    expect(v2.r.vinculados).toBe(0); // write-once
    const alta = await b.fila<{ origen_payment_event_id: string }>(`SELECT origen_payment_event_id FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'alta'`, [act.r.membresia_id]);
    expect(alta.origen_payment_event_id).toBe(pago);
    // Cualquier otro UPDATE del ledger sigue prohibido; reasignar el vínculo también.
    await expect(b.db.query(`UPDATE membresia_movimientos SET origen_payment_event_id = NULL WHERE membresia_id = $1 AND tipo = 'alta'`, [act.r.membresia_id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
    await expect(b.db.query(`UPDATE membresia_movimientos SET delta = 99 WHERE membresia_id = $1 AND tipo = 'alta'`, [act.r.membresia_id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
    expect((await b.filas(`SELECT 1 FROM movimientos_sin_vinculo WHERE membresia_id = $1`, [act.r.membresia_id])).length).toBe(0);
    // La misma función protege audit_log: sigue siendo inmutable tras la ampliación.
    const a = await b.fila<{ id: string }>(`SELECT id FROM audit_log ORDER BY creada_at DESC LIMIT 1`);
    await expect(b.db.query(`UPDATE audit_log SET motivo = 'x' WHERE id = $1`, [a.id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
    await expect(b.db.query(`DELETE FROM audit_log WHERE id = $1`, [a.id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
  });

  it('suscripción Stripe: alta → suscripcion_stripe (y queda en movimientos_sin_vinculo hasta vincular)', async () => {
    const p = await b.crearPersona();
    const act = await b.fila<{ r: { membresia_id: string } }>(
      `SELECT activar_membresia($1, $2, 'sub_prov_1', 'cus_y', now() + interval '30 days') AS r`, [p.id, await b.tierId('esencial')]);
    const alta = await b.fila<{ origen: string }>(`SELECT origen FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'alta'`, [act.r.membresia_id]);
    expect(alta.origen).toBe('suscripcion_stripe');
    expect((await b.filas(`SELECT 1 FROM movimientos_sin_vinculo WHERE membresia_id = $1`, [act.r.membresia_id])).length).toBe(1);
  });

  it('mostrador y cortesía: alta → venta_mostrador / cortesia con origen_venta_id', async () => {
    const p = await b.crearPersona();
    const op1 = randomUUID();
    const v1 = await b.fila<{ r: { membresia_id: string; venta_id: string } }>(
      `SELECT registrar_venta_mostrador($1, $2, $3, $4, 'efectivo', NULL, NULL, false) AS r`, [op1, recep.id, p.id, await b.tierId('creador')]);
    const a1 = await b.fila<{ origen: string; origen_venta_id: string | null }>(`SELECT origen, origen_venta_id FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'alta'`, [v1.r.membresia_id]);
    expect(a1.origen).toBe('venta_mostrador');
    expect(a1.origen_venta_id).not.toBeNull();
    const p2 = await b.crearPersona();
    const v2 = await b.fila<{ r: { membresia_id: string } }>(
      `SELECT registrar_venta_mostrador($1, $2, $3, $4, 'cortesia', NULL, NULL, false) AS r`, [randomUUID(), recep.id, p2.id, await b.tierId('creador')]);
    expect((await b.fila<{ origen: string }>(`SELECT origen FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'alta'`, [v2.r.membresia_id])).origen).toBe('cortesia');
  });

  it('reserva: débito y devolución → reserva; recompra: cierre_sistema (saldo a 0) y traslado (saldo que pasa)', async () => {
    const p = await b.crearPersona();
    const act = await b.fila<{ r: { membresia_id: string } }>(`SELECT activar_membresia($1, $2, NULL, 'cus_z', NULL, 'pi_prov_2') AS r`, [p.id, await b.tierId('creador')]);
    const estudio = await b.crearEstudio();
    const res = await b.reservar(p, estudio, await b.slot(2));
    expect(res.success).toBe(true);
    const deb = await b.fila<{ origen: string }>(`SELECT origen FROM membresia_movimientos WHERE reserva_id = $1 AND tipo = 'debito'`, [res.reserva_id]);
    expect(deb.origen).toBe('reserva');
    await b.db.query(`UPDATE reservas SET status = 'cancelada_admin', cancelada_at = now() WHERE id = $1`, [res.reserva_id]);
    const dev = await b.fila<{ origen: string }>(`SELECT origen FROM membresia_movimientos WHERE reserva_id = $1 AND tipo = 'devolucion'`, [res.reserva_id]);
    expect(dev.origen).toBe('reserva');
    // Recompra: la fila anterior se cierra (cierre_sistema) y su saldo pasa a la nueva (traslado).
    const act2 = await b.fila<{ r: { membresia_id: string } }>(`SELECT activar_membresia($1, $2, NULL, 'cus_z', NULL, 'pi_prov_3') AS r`, [p.id, await b.tierId('creador')]);
    const cierre = await b.fila<{ origen: string }>(`SELECT origen FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'ajuste' ORDER BY created_at DESC LIMIT 1`, [act.r.membresia_id]);
    expect(cierre.origen).toBe('cierre_sistema');
    const traslado = await b.fila<{ origen: string; delta: number }>(`SELECT origen, delta FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'ajuste'`, [act2.r.membresia_id]);
    expect(traslado).toMatchObject({ origen: 'traslado' });
    expect(traslado.delta).toBeGreaterThan(0);
    // Un ajuste de staff (actor autenticado) → ajuste_staff.
    await b.como(recep, () => b.fila(`SELECT staff_ajustar_creditos($1, 1, 'Cortesía por demora')`, [p.id]));
    const staff = await b.fila<{ origen: string }>(`SELECT origen FROM membresia_movimientos WHERE membresia_id = $1 AND tipo = 'ajuste' ORDER BY created_at DESC LIMIT 1`, [act2.r.membresia_id]);
    expect(staff.origen).toBe('ajuste_staff');
    const lotes = await b.filas<{ origen: string; otorgado: number | null }>(`SELECT origen, otorgado::int AS otorgado FROM valor_por_lote WHERE membresia_id = $1 ORDER BY origen`, [act2.r.membresia_id]);
    expect(lotes.map((l) => l.origen).sort()).toEqual(['ajuste_staff', 'compra_stripe', 'traslado']);
  });

  it('histórico: una fila insertada "como antes" con origen explícito desconocido se conserva; sin backfill en la migración', async () => {
    const sql = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../../../supabase/migrations/20261002100000_reversales_y_revision.sql'), 'utf8'
    ).replace(/^\s*--.*$/gm, '');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX)\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+membresia_movimientos\s+SET\s+origen\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+(membresias|payment_events|usuarios|reservas)\b/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION (activar_membresia|sync_membresia_stripe|cambiar_tier_membresia|registrar_venta_mostrador|claim_stripe_event)\b/);
    const defecto = await b.fila<{ d: string }>(`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'membresia_movimientos' AND column_name = 'origen'`);
    expect(defecto.d).toContain('desconocido');
  });
});
