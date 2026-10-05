// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * R2-B · PKG-01N · migración 20261005100000 contra Postgres real (PGlite).
 *
 * `v_libro_economico` compone la evidencia existente (payment_events,
 * ventas_mostrador, reversales_pago, stripe_webhook_events) sin copiar dinero:
 *   BRUTO = cobros firmes, una vez cada uno.
 *   NETO  = SUM(efecto_neto_centavos) = bruto − reversales firmes con origen firme.
 *   Lo no atribuible queda `sin_resolver`, visible y FUERA del neto.
 *
 * Cada test usa su propio tenant para que los totales sean exactos.
 */

let b: BaseDePrueba;

type Fila = {
  fuente: string; clase: string; origen_negocio: string; canal: string; moneda: string;
  monto_centavos: number; efecto_neto_centavos: number; estado_evidencia: string; motivo: string | null;
  revision_abierta: boolean; ocurrido_at: string; stripe_object_id: string | null;
};

const id8 = () => randomUUID().slice(0, 8);

async function nuevoTenant(cuenta: string | null = null): Promise<string> {
  const slug = `t-${id8()}`;
  const r = await b.fila<{ id: string }>(
    `INSERT INTO tenants (slug, nombre, stripe_account_id) VALUES ($1, $1, $2) RETURNING id`, [slug, cuenta]);
  return r.id;
}

async function pago(o: {
  tenant: string | null; tipo?: 'invoice.paid' | 'payment_intent.succeeded' | 'invoice.payment_failed';
  monto?: number; status?: string; pi?: string | null; meta?: Record<string, string> | null;
  billing?: string; moneda?: string; created?: number; account?: string; evento?: string;
}): Promise<string> {
  const tipo = o.tipo ?? 'payment_intent.succeeded';
  const meta = o.meta === undefined ? { app: 'ekko' } : o.meta;
  const objeto: Record<string, unknown> = {};
  if (meta) objeto.metadata = meta;
  if (o.billing) objeto.billing_reason = o.billing;
  const payload: Record<string, unknown> = { data: { object: objeto } };
  if (o.created) payload.created = o.created;
  if (o.account) payload.account = o.account;
  const r = await b.fila<{ id: string }>(
    `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, stripe_payment_intent_id, monto_centavos, moneda, status, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
    [o.tenant, o.evento ?? `evt_${id8()}`, tipo, o.pi === undefined ? `pi_${id8()}` : o.pi, o.monto ?? 100000, o.moneda ?? 'mxn',
     o.status ?? (tipo === 'invoice.payment_failed' ? 'failed' : 'succeeded'), JSON.stringify(payload)]);
  return r.id;
}

async function reversal(o: {
  tenant: string; tipo?: 'reembolso' | 'disputa'; monto: number; estado: string; origen?: string | null; objeto?: string; fecha?: string;
}): Promise<string> {
  const tipo = o.tipo ?? 'reembolso';
  const r = await b.fila<{ id: string }>(
    `INSERT INTO reversales_pago (tenant_id, tipo, stripe_object_id, stripe_charge_id, pago_origen_id, monto_centavos, moneda,
                                  estado_proveedor, stripe_created_at, ultimo_evento_at, ultimo_stripe_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'mxn', $7, $8::timestamptz, now(), $9) RETURNING id`,
    [o.tenant, tipo, o.objeto ?? `${tipo === 'reembolso' ? 're' : 'dp'}_${id8()}`, `ch_${id8()}`, o.origen ?? null, o.monto, o.estado,
     o.fecha ?? new Date().toISOString(), `evt_${id8()}`]);
  return r.id;
}

const libro = (tenant: string) =>
  b.filas<Fila>('SELECT * FROM v_libro_economico WHERE tenant_id = $1 ORDER BY ocurrido_at, fuente_id', [tenant]);

const totales = (tenant: string) =>
  b.fila<{ bruto: number; reversado: number; neto: number; sin_resolver: number }>(
    `SELECT COALESCE(SUM(monto_centavos) FILTER (WHERE clase = 'cobro' AND estado_evidencia = 'firme'), 0)::int AS bruto,
            COALESCE(-SUM(efecto_neto_centavos) FILTER (WHERE clase IN ('reembolso', 'disputa')), 0)::int AS reversado,
            COALESCE(SUM(efecto_neto_centavos), 0)::int AS neto,
            COALESCE(SUM(monto_centavos) FILTER (WHERE estado_evidencia = 'sin_resolver'), 0)::int AS sin_resolver
     FROM v_libro_economico WHERE tenant_id = $1`, [tenant]);

beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('bruto: cada cobro firme una vez', () => {
  it('factura pagada y paquete cuentan; el cobro fallido no aparece; clasificación por origen', async () => {
    const t = await nuevoTenant();
    await pago({ tenant: t, tipo: 'invoice.paid', monto: 85000, meta: null, billing: 'subscription_create' });
    await pago({ tenant: t, tipo: 'invoice.paid', monto: 85000, meta: null, billing: 'subscription_cycle' });
    await pago({ tenant: t, tipo: 'invoice.paid', monto: 35000, meta: null, billing: 'subscription_update' });
    await pago({ tenant: t, monto: 120000 });
    await pago({ tenant: t, monto: 90000, meta: { app: 'ekko', origen: 'mostrador' } });
    await pago({ tenant: t, tipo: 'invoice.payment_failed', monto: 85000, meta: null });
    const filas = await libro(t);
    expect(filas).toHaveLength(5);
    expect(filas.map((f) => `${f.origen_negocio}/${f.canal}`).sort()).toEqual(
      ['cambio_de_plan/app', 'paquete/app', 'paquete/mostrador_stripe', 'suscripcion_alta/app', 'suscripcion_renovacion/app']);
    expect(filas.every((f) => f.estado_evidencia === 'firme' && f.clase === 'cobro')).toBe(true);
    expect(await totales(t)).toEqual({ bruto: 415000, reversado: 0, neto: 415000, sin_resolver: 0 });
  });

  it('reintento del webhook (mismo stripe_event_id) no duplica: UNIQUE del diario', async () => {
    const t = await nuevoTenant();
    await pago({ tenant: t, monto: 50000, evento: 'evt_retry_r2b' });
    await expect(pago({ tenant: t, monto: 50000, evento: 'evt_retry_r2b' })).rejects.toThrow(/duplicate key/);
    expect((await totales(t)).bruto).toBe(50000);
  });

  it('venta de mostrador (efectivo/transferencia/terminal) cuenta; cortesía aparece con 0; moneda normalizada', async () => {
    const t = await nuevoTenant();
    const tier = await b.fila<{ id: string }>(
      `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, reglas)
       VALUES ($1, 'plan', 'Plan', 85000, 'MXN', 'mensual', '{"max_invitados": 0}') RETURNING id`, [t]);
    const u = await b.fila<{ id: string }>(`INSERT INTO usuarios (tenant_id, email, nombre, rol) VALUES ($1, $2, 'X', 'miembro') RETURNING id`, [t, `${id8()}@x.mx`]);
    const venta = (metodo: string, monto: number) => b.db.query(
      `INSERT INTO ventas_mostrador (tenant_id, operation_id, usuario_id, tier_id, tier_slug, tier_nombre, tier_tipo,
                                     precio_lista_centavos, monto_cobrado_centavos, moneda, metodo, actor_usuario_id, actor_rol)
       VALUES ($1, gen_random_uuid(), $2, $3, 'plan', 'Plan', 'tiempo', 85000, $4, 'MXN', $5, $2, 'admin')`, [t, u.id, tier.id, monto, metodo]);
    await venta('efectivo', 85000);
    await venta('terminal', 85000);
    await venta('cortesia', 0);
    const filas = await libro(t);
    expect(filas.map((f) => [f.clase, f.canal, f.moneda, f.efecto_neto_centavos]).sort()).toEqual([
      ['cobro', 'mostrador_efectivo', 'mxn', 85000], ['cobro', 'mostrador_terminal', 'mxn', 85000], ['cortesia', 'mostrador_cortesia', 'mxn', 0]]);
    expect(await totales(t)).toMatchObject({ bruto: 170000, neto: 170000 });
  });

  it('invitados extra: el PaymentIntent está en payment_events Y en invitados_extra_pagos y se cuenta UNA vez', async () => {
    const t = await nuevoTenant('acct_extra_r2b');
    const m: Persona = await b.crearPersona();
    await b.db.query('UPDATE usuarios SET tenant_id = $2 WHERE id = $1', [m.id, t]);
    const tier = await b.fila<{ id: string }>(
      `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, reglas)
       VALUES ($1, 'plan', 'Plan', 85000, 'mxn', 'mensual', '{"max_invitados": 2}') RETURNING id`, [t]);
    await b.db.query(`INSERT INTO membresias (tenant_id, usuario_id, tier_id, status) VALUES ($1, $2, $3, 'activa')`, [t, m.id, tier.id]);
    const rec = await b.fila<{ id: string }>(
      `INSERT INTO recursos (tenant_id, nombre, slug, activo, tiers_permitidos, costo_creditos) VALUES ($1, 'Set', 'set', true, '{}', 1) RETURNING id`, [t]);
    const res = await b.fila<{ id: string }>(
      `INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, status, folio)
       VALUES ($1, $2, $3, now() + interval '2 days', now() + interval '2 days 1 hour', 60, 'confirmada', 'EKK-R2B') RETURNING id`, [t, rec.id, m.id]);
    const pi = `pi_${id8()}`;
    await pago({ tenant: t, pi, monto: 20000, meta: { app: 'ekko', tipo: 'invitados_extra' } });
    const ap = await b.fila<{ r: { estado: string } }>(
      `SELECT aplicar_invitados_extra_pago($1, 'acct_extra_r2b', $2, $3, $4, $5, 2, 20000, 10000, 'mxn', now(), NULL) AS r`,
      [pi, t, `evt_${id8()}`, res.id, m.id]);
    expect(ap.r.estado).toBe('aplicado');
    const filas = await libro(t);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ origen_negocio: 'invitados_extra', monto_centavos: 20000, estado_evidencia: 'firme', motivo: null });
    expect((await totales(t)).bruto).toBe(20000);

    // Un pago que NO se pudo aplicar sigue siendo dinero cobrado (firme), marcado y con revisión abierta.
    const pi2 = `pi_${id8()}`;
    await pago({ tenant: t, pi: pi2, monto: 30000, meta: { app: 'ekko', tipo: 'invitados_extra' } });
    await b.fila(`SELECT aplicar_invitados_extra_pago($1, 'acct_extra_r2b', $2, $3, $4, $5, 2, 30000, 10000, 'mxn', now(), NULL)`,
      [pi2, t, `evt_${id8()}`, res.id, m.id]);
    const f2 = (await libro(t)).find((f) => f.monto_centavos === 30000)!;
    expect(f2.estado_evidencia).toBe('firme');
    expect(f2.motivo).toMatch(/^extra_no_aplicado:/);
    expect(f2.revision_abierta).toBe(true);
    expect((await totales(t)).bruto).toBe(50000);
  });
});

describe('reversales: monto exacto, una vez, solo si es firme', () => {
  it('reembolso parcial resta exacto; varios parciales suman; el fallido y el pendiente no restan', async () => {
    const t = await nuevoTenant();
    const p = await pago({ tenant: t, monto: 100000 });
    await reversal({ tenant: t, monto: 10000, estado: 'succeeded', origen: p });
    expect(await totales(t)).toMatchObject({ bruto: 100000, reversado: 10000, neto: 90000 });
    await reversal({ tenant: t, monto: 5000, estado: 'succeeded', origen: p });
    await reversal({ tenant: t, monto: 20000, estado: 'failed', origen: p });
    await reversal({ tenant: t, monto: 7000, estado: 'canceled', origen: p });
    await reversal({ tenant: t, monto: 30000, estado: 'pending', origen: p });
    expect(await totales(t)).toMatchObject({ bruto: 100000, reversado: 15000, neto: 85000 });
    const estados = (await libro(t)).filter((f) => f.clase === 'reembolso').map((f) => `${f.monto_centavos}:${f.estado_evidencia}`).sort();
    expect(estados).toEqual(['10000:firme', '20000:anulado', '30000:pendiente', '5000:firme', '7000:anulado']);
  });

  it('un reembolso que primero salió y luego FALLA deja de restar (estado del proveedor, misma fila)', async () => {
    const t = await nuevoTenant();
    const p = await pago({ tenant: t, monto: 100000 });
    const r = await reversal({ tenant: t, monto: 40000, estado: 'succeeded', origen: p });
    expect((await totales(t)).neto).toBe(60000);
    await b.db.query(`UPDATE reversales_pago SET estado_proveedor = 'failed', ultimo_evento_at = now() + interval '1 second' WHERE id = $1`, [r]);
    expect(await totales(t)).toMatchObject({ reversado: 0, neto: 100000 });
  });

  it('reintento del mismo Refund (mismo re_…) no resta dos veces: UNIQUE por objeto', async () => {
    const t = await nuevoTenant();
    const p = await pago({ tenant: t, monto: 100000 });
    await reversal({ tenant: t, monto: 10000, estado: 'succeeded', origen: p, objeto: 're_retry_r2b' });
    await expect(reversal({ tenant: t, monto: 10000, estado: 'succeeded', origen: p, objeto: 're_retry_r2b' })).rejects.toThrow(/duplicate key/);
    expect((await totales(t)).reversado).toBe(10000);
  });

  it('disputas: abierta = en_disputa (no resta); perdida resta; ganada y cerrada-por-reembolso no restan', async () => {
    const t = await nuevoTenant();
    const p = await pago({ tenant: t, monto: 100000 });
    const d = await reversal({ tenant: t, tipo: 'disputa', monto: 100000, estado: 'needs_response', origen: p });
    let f = (await libro(t)).find((x) => x.clase === 'disputa')!;
    expect(f).toMatchObject({ estado_evidencia: 'en_disputa', efecto_neto_centavos: 0, motivo: 'needs_response' });
    expect((await totales(t)).neto).toBe(100000);
    await b.db.query(`UPDATE reversales_pago SET estado_proveedor = 'lost', ultimo_evento_at = now() + interval '1 second' WHERE id = $1`, [d]);
    expect(await totales(t)).toMatchObject({ reversado: 100000, neto: 0 });
    await b.db.query(`UPDATE reversales_pago SET estado_proveedor = 'won', ultimo_evento_at = now() + interval '2 seconds' WHERE id = $1`, [d]);
    f = (await libro(t)).find((x) => x.clase === 'disputa')!;
    expect(f).toMatchObject({ estado_evidencia: 'anulado', efecto_neto_centavos: 0, motivo: 'disputa_won' });
    await b.db.query(`UPDATE reversales_pago SET estado_proveedor = 'charge_refunded', ultimo_evento_at = now() + interval '3 seconds' WHERE id = $1`, [d]);
    expect(await totales(t)).toMatchObject({ reversado: 0, neto: 100000 });
  });

  it('reversal SIN origen resuelto: visible, sin_resolver y FUERA del neto (no se resta un origen adivinado)', async () => {
    const t = await nuevoTenant();
    await pago({ tenant: t, monto: 100000 });
    await reversal({ tenant: t, monto: 25000, estado: 'succeeded', origen: null });
    const f = (await libro(t)).find((x) => x.clase === 'reembolso')!;
    expect(f).toMatchObject({ estado_evidencia: 'sin_resolver', motivo: 'reversal_sin_origen', origen_negocio: 'sin_origen', efecto_neto_centavos: 0, monto_centavos: 25000 });
    expect(await totales(t)).toEqual({ bruto: 100000, reversado: 0, neto: 100000, sin_resolver: 25000 });
  });

  it('revisión financiera abierta se refleja en la fila del reversal y en la del pago de origen', async () => {
    const t = await nuevoTenant();
    const p = await pago({ tenant: t, monto: 100000 });
    const r = await reversal({ tenant: t, monto: 10000, estado: 'succeeded', origen: p });
    expect((await libro(t)).every((f) => f.revision_abierta === false)).toBe(true);
    await b.db.query(`INSERT INTO revisiones_financieras (tenant_id, reversal_id, tipo) VALUES ($1, $2, 'reembolso')`, [t, r]);
    expect((await libro(t)).map((f) => f.revision_abierta)).toEqual([true, true]);
  });
});

describe('lo histórico o no atribuible queda sin resolver, nunca adivinado', () => {
  it('PaymentIntent histórico sin metadata de EKKO: sin_resolver; de otra app: excluido; ninguno entra al bruto', async () => {
    const t = await nuevoTenant();
    await pago({ tenant: t, tipo: 'invoice.paid', monto: 100000, meta: null, billing: 'subscription_create' });
    const legacy = await pago({ tenant: t, monto: 100000, meta: null });
    await pago({ tenant: t, monto: 150000, meta: { app: 'hogar' } });
    const filas = await libro(t);
    expect(filas.map((f) => `${f.estado_evidencia}:${f.motivo}`).sort()).toEqual(['excluido:app_ajena', 'firme:null', 'sin_resolver:pi_sin_metadata_ekko']);
    expect(await totales(t)).toEqual({ bruto: 100000, reversado: 0, neto: 100000, sin_resolver: 100000 });
    // Un reembolso ligado al pago histórico tampoco resta: su origen no es firme.
    await reversal({ tenant: t, monto: 100000, estado: 'succeeded', origen: legacy });
    const rv = (await libro(t)).find((f) => f.clase === 'reembolso')!;
    expect(rv).toMatchObject({ estado_evidencia: 'sin_resolver', motivo: 'reversal_de_pago_no_firme', efecto_neto_centavos: 0 });
    expect((await totales(t)).neto).toBe(100000);
  });

  it('PaymentIntent que además pagó una factura ya contada: excluido como duplicado', async () => {
    const t = await nuevoTenant();
    await pago({ tenant: t, tipo: 'invoice.paid', monto: 85000, meta: null, pi: 'pi_dup_r2b', billing: 'subscription_cycle' });
    await pago({ tenant: t, monto: 85000, pi: 'pi_dup_r2b' });
    const filas = await libro(t);
    expect(filas.map((f) => `${f.estado_evidencia}:${f.motivo}`).sort()).toEqual(['excluido:duplicado_de_factura', 'firme:null']);
    expect((await totales(t)).bruto).toBe(85000);
  });

  it('cobro cuyo evento quedó en revisión y no llegó al diario: visible como sin_resolver, fuera del neto; al procesarse entra una vez', async () => {
    const t = await nuevoTenant('acct_rev_r2b');
    const evento = `evt_${id8()}`;
    await b.db.query(
      `INSERT INTO stripe_webhook_events (id, type, estado, motivo, stripe_account, event_created_at, resumen)
       VALUES ($1, 'payment_intent.succeeded', 'revision', 'faltan_datos', 'acct_rev_r2b', now(), $2::jsonb)`,
      [evento, JSON.stringify({ id: 'pi_rev_r2b', monto: 120000, currency: 'mxn', metadata: { app: 'ekko' } })]);
    // Uno de suscripción ajena al filtro (PI sin metadata ekko) y uno ya procesado: no aparecen.
    await b.db.query(
      `INSERT INTO stripe_webhook_events (id, type, estado, stripe_account, resumen)
       VALUES ($1, 'payment_intent.succeeded', 'revision', 'acct_rev_r2b', '{"monto": 999}'::jsonb)`, [`evt_${id8()}`]);
    let filas = await libro(t);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ fuente: 'stripe_webhook_events', estado_evidencia: 'sin_resolver', motivo: 'evento_revision:faltan_datos', monto_centavos: 120000, efecto_neto_centavos: 0 });
    expect(await totales(t)).toEqual({ bruto: 0, reversado: 0, neto: 0, sin_resolver: 120000 });
    // El evento se procesa: aparece el diario y la fila "sin registrar" desaparece (no se cuenta dos veces).
    await pago({ tenant: t, monto: 120000, pi: 'pi_rev_r2b', evento });
    filas = await libro(t);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ fuente: 'payment_events', estado_evidencia: 'firme' });
    expect(await totales(t)).toEqual({ bruto: 120000, reversado: 0, neto: 120000, sin_resolver: 0 });
  });

  it('tenant: si el diario no lo trae, se resuelve por la cuenta conectada (única); cuenta de dos tenants → no se adivina', async () => {
    const t = await nuevoTenant('acct_unica_r2b');
    await pago({ tenant: null, monto: 70000, account: 'acct_unica_r2b' });
    expect((await totales(t)).bruto).toBe(70000);
    const a = await nuevoTenant('acct_compartida_r2b');
    const c = await nuevoTenant('acct_compartida_r2b');
    await pago({ tenant: null, monto: 10000, account: 'acct_compartida_r2b' });
    expect((await totales(a)).bruto + (await totales(c)).bruto).toBe(0);
  });
});

describe('fecha del proveedor, moneda y aislamiento', () => {
  it('ocurrido_at es la fecha del proveedor (raw_payload.created), no la de inserción', async () => {
    const t = await nuevoTenant();
    const created = Math.floor(new Date('2026-08-15T18:00:00Z').getTime() / 1000);
    await pago({ tenant: t, monto: 1000, created });
    const f = (await libro(t))[0];
    expect(new Date(f.ocurrido_at).toISOString()).toBe('2026-08-15T18:00:00.000Z');
  });

  it('monedas distintas no se mezclan: la moneda es columna explícita y normalizada', async () => {
    const t = await nuevoTenant();
    await pago({ tenant: t, monto: 100000, moneda: 'MXN' });
    await pago({ tenant: t, monto: 5000, moneda: 'usd' });
    const porMoneda = await b.filas<{ moneda: string; neto: number }>(
      `SELECT moneda, SUM(efecto_neto_centavos)::int AS neto FROM v_libro_economico WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [t]);
    expect(porMoneda).toEqual([{ moneda: 'mxn', neto: 100000 }, { moneda: 'usd', neto: 5000 }]);
  });

  it('RPC libro_economico: solo admin, solo su estudio, solo el rango; la vista no se lee por REST', async () => {
    const admin = await b.crearPersona({ rol: 'admin' });
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const miembro = await b.crearPersona();
    const otro = await nuevoTenant();
    await pago({ tenant: otro, monto: 999900 });
    const created = Math.floor(new Date('2026-06-10T18:00:00Z').getTime() / 1000);
    await pago({ tenant: b.tenantId, monto: 12300, created, pi: 'pi_rango_r2b' });
    await pago({ tenant: b.tenantId, monto: 45600, created: created + 40 * 86400 });
    const rpc = (p: Persona, desde: string, hasta: string) =>
      b.como(p, () => b.filas<Fila & { tenant_id: string }>('SELECT * FROM libro_economico($1::timestamptz, $2::timestamptz)', [desde, hasta]));
    const filas = await rpc(admin, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(filas.map((f) => f.monto_centavos)).toEqual([12300]);
    expect(filas.every((f) => f.tenant_id === b.tenantId)).toBe(true);
    await expect(rpc(recep, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(rpc(miembro, '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(rpc(admin, '2026-07-01T00:00:00Z', '2026-06-01T00:00:00Z')).rejects.toThrow(/EKKO_RANGO_INVALIDO/);
    await expect(b.como(admin, () => b.filas('SELECT 1 FROM v_libro_economico'))).rejects.toThrow(/permission denied/);
    const priv = async (rol: string) =>
      (await b.fila<{ p: boolean }>(`SELECT has_function_privilege($1, 'libro_economico(timestamptz, timestamptz)', 'EXECUTE') AS p`, [rol])).p;
    expect(await priv('anon')).toBe(false);
    expect(await priv('authenticated')).toBe(true);
  });

  it('la vista no escribe ni cambia la evidencia: 01G y 01H siguen inmutables', async () => {
    const t = await nuevoTenant();
    const p = await pago({ tenant: t, monto: 100000 });
    const r = await reversal({ tenant: t, monto: 10000, estado: 'succeeded', origen: p });
    await libro(t);
    await expect(b.db.query('UPDATE reversales_pago SET monto_centavos = 1 WHERE id = $1', [r])).rejects.toThrow(/EKKO_REVERSAL_INMUTABLE/);
    await expect(b.db.query('DELETE FROM reversales_pago WHERE id = $1', [r])).rejects.toThrow(/EKKO_REVERSAL_INMUTABLE/);
  });
});
