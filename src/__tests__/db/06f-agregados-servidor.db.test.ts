// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';
import { calcularCreditos, creditosDesdeTotales, type CreditosTotales } from '../../admin/logic/reportesCreditos';
import { agruparLibro, calcularCobrado, calcularCobradoAgregado, type LibroFila, type LibroGrupo } from '../../admin/logic/reportesCobrado';
import { calcularEconomia, type MembresiaLite, type TierLite } from '../../admin/logic/reportesEconomia';
import { inicioDeMesEnZona } from '../../shared/lib/timezone';

/**
 * PKG-06F · migración 20261019100000 contra Postgres real (PGlite), con MÁS de
 * 1000 filas reales por fuente. Cada total del servidor se compara con el mismo
 * cálculo del cliente sobre TODAS las filas (equivalencia: el KPI no cambia de
 * significado) y con el modelo viejo, que solo veía las primeras 1000 (el tope de
 * PostgREST): ahí el total sale distinto — lo que el servidor ya no permite.
 */

const CAP = 1000; // max_rows de PostgREST en producción

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let miembro: Persona;
let membresiaA: string;
let tenantB: string;

type J = Record<string, unknown>;
const comoAdmin = <T = J>(sql: string, params: unknown[] = []) => b.como(admin, () => b.filas<T>(sql, params));

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  miembro = await b.crearPersona();
  await b.activar(miembro, 'pro-pack');
  membresiaA = (await b.fila<{ id: string }>(`SELECT id FROM membresias WHERE usuario_id = $1`, [miembro.id])).id;

  // ── 1,500 movimientos de créditos del estudio A (alta +2 · débito −1 · no-show −1 · devolución +1)
  await b.db.query(
    `INSERT INTO membresia_movimientos (tenant_id, membresia_id, usuario_id, tipo, delta, created_at)
     SELECT $1, $2, $3,
            (ARRAY['alta','debito','no_show','devolucion'])[1 + (g % 4)],
            (ARRAY[2, -1, -1, 1])[1 + (g % 4)],
            now() - make_interval(mins => g)
     FROM generate_series(1, 1500) g`,
    [b.tenantId, membresiaA, miembro.id]
  );

  // ── Estudio B con 1,200 movimientos propios (no deben contar para A)
  tenantB = (await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-06f', 'Otro', 'activo') RETURNING id`)).id;
  const uB = (await b.fila<{ id: string }>(`INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES ($1, 'b06f@test.mx', 'B', 'miembro', 'activo') RETURNING id`, [tenantB])).id;
  const mB = (await b.fila<{ id: string }>(`INSERT INTO membresias (usuario_id, tenant_id, tier_id, status, creditos_restantes) VALUES ($1, $2, $3, 'activa', 50) RETURNING id`, [uB, tenantB, await b.tierId('pro-pack')])).id;
  await b.db.query(
    `INSERT INTO membresia_movimientos (tenant_id, membresia_id, usuario_id, tipo, delta) SELECT $1, $2, $3, 'alta', 7 FROM generate_series(1, 1200)`,
    [tenantB, mB, uB]
  );
}, 180_000);

afterAll(async () => {
  await b.db.close();
});

describe('FR-62/63 · pasivo de créditos (reporte_creditos)', () => {
  it('1/3/4/8/9/15 · con 1,500 movimientos el total del servidor = cálculo del cliente sobre TODO; el modelo viejo (1000 filas) daba otro número', async () => {
    const [tot] = await comoAdmin<CreditosTotales>('SELECT * FROM reporte_creditos()');
    const todos = await b.filas<{ tipo: string; delta: number }>(`SELECT tipo, delta FROM membresia_movimientos WHERE tenant_id = $1 ORDER BY id`, [b.tenantId]);
    expect(todos.length).toBeGreaterThan(CAP);
    const saldos = await b.filas<{ creditos_restantes: number; precio_centavos: number; clases_incluidas: number }>(
      `SELECT ms.creditos_restantes, t.precio_centavos, t.clases_incluidas FROM membresias ms JOIN tiers t ON t.id = ms.tier_id
       WHERE ms.tenant_id = $1 AND ms.status IN ('trialing','activa','past_due') AND ms.creditos_restantes IS NOT NULL`, [b.tenantId]);
    const esperado = calcularCreditos(todos, saldos);
    expect(creditosDesdeTotales(tot)).toEqual(esperado);
    // El modelo viejo: la respuesta cortada en 1000 filas.
    const recortado = calcularCreditos(todos.slice(0, CAP), saldos);
    expect(recortado.vendidos).not.toBe(esperado.vendidos);
    expect(recortado.usados).not.toBe(esperado.usados);
    // 26/27 · enteros exactos (bigint → número), sin flotantes.
    expect(Number.isInteger(Number(tot.vendidos)) && Number.isInteger(Number(tot.valor_pasivo_centavos))).toBe(true);
  });

  it('6/24/25 · aislamiento: los 1,200 movimientos del estudio B no suman en A, y no hay parámetro de estudio que forzar', async () => {
    const [tot] = await comoAdmin<CreditosTotales>('SELECT * FROM reporte_creditos()');
    const soloA = await b.fila<{ v: string }>(`SELECT COALESCE(sum(GREATEST(0, delta)) FILTER (WHERE tipo = 'alta'), 0) AS v FROM membresia_movimientos WHERE tenant_id = $1`, [b.tenantId]);
    expect(Number(tot.vendidos)).toBe(Number(soloA.v));
    const args = await b.fila<{ n: number }>(`SELECT pronargs AS n FROM pg_proc WHERE proname = 'reporte_creditos'`);
    expect(args.n).toBe(0);
  });

  it('11/28 · un estudio sin movimientos ni saldos → ceros (una fila), no nulos ni error', async () => {
    const vacio = (await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('vacio-06f', 'Vacío', 'activo') RETURNING id`)).id;
    const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-vacio-06f@test.mx', '{"tenant_slug":"vacio-06f"}') RETURNING id`);
    const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = $1 RETURNING id`, [a.id]);
    const filas = await b.como({ authId: a.id, id: u.id }, () => b.filas<CreditosTotales>('SELECT * FROM reporte_creditos()'));
    expect(filas).toHaveLength(1);
    expect(creditosDesdeTotales(filas[0])).toEqual({ pasivoSesiones: 0, valorPasivoCentavos: 0, miembrosConSaldo: 0, vendidos: 0, usados: 0, tasaUsoPct: null });
    expect(vacio).toBeTruthy();
  });
});

describe('FR-62/63 · libro económico agrupado y cobros fallidos', () => {
  let inicioMes: Date;
  let inicioMesAnterior: Date;
  beforeAll(async () => {
    const ahora = new Date();
    inicioMes = inicioDeMesEnZona(0, ahora);
    inicioMesAnterior = inicioDeMesEnZona(-1, ahora);
    const enMes = Math.floor((inicioMes.getTime() + 60_000) / 1000);
    const mesAnt = Math.floor((inicioMesAnterior.getTime() + 86_400_000) / 1000);
    // 1,100 paquetes firmes este mes · 150 renovaciones el mes anterior · 60 sin metadata (sin resolver) este mes
    await b.db.query(
      `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, stripe_payment_intent_id, monto_centavos, moneda, status, raw_payload)
       SELECT $1, 'evt_06f_p_' || g, 'payment_intent.succeeded', 'pi_06f_p_' || g, 10000 + g, 'mxn', 'succeeded',
              jsonb_build_object('created', $2::bigint, 'data', jsonb_build_object('object', jsonb_build_object('metadata', jsonb_build_object('app', 'ekko'))))
       FROM generate_series(1, 1100) g`, [b.tenantId, enMes]);
    await b.db.query(
      `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, stripe_payment_intent_id, monto_centavos, moneda, status, raw_payload)
       SELECT $1, 'evt_06f_r_' || g, 'invoice.paid', 'pi_06f_r_' || g, 85000, 'mxn', 'succeeded',
              jsonb_build_object('created', $2::bigint, 'data', jsonb_build_object('object', jsonb_build_object('billing_reason', 'subscription_cycle')))
       FROM generate_series(1, 150) g`, [b.tenantId, mesAnt]);
    await b.db.query(
      `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, stripe_payment_intent_id, monto_centavos, moneda, status, raw_payload)
       SELECT $1, 'evt_06f_s_' || g, 'payment_intent.succeeded', 'pi_06f_s_' || g, 777, 'mxn', 'succeeded',
              jsonb_build_object('created', $2::bigint, 'data', jsonb_build_object('object', '{}'::jsonb))
       FROM generate_series(1, 60) g`, [b.tenantId, enMes]);
    // 1,200 cobros fallidos recientes en A y 50 en B
    await b.db.query(
      `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, monto_centavos, moneda, status, raw_payload)
       SELECT $1, 'evt_06f_f_' || g, 'invoice.payment_failed', CASE WHEN g % 10 = 0 THEN NULL ELSE 5000 END, 'mxn', 'failed', '{}'::jsonb
       FROM generate_series(1, 1200) g`, [b.tenantId]);
    await b.db.query(
      `INSERT INTO payment_events (tenant_id, stripe_event_id, stripe_event_type, monto_centavos, moneda, status, raw_payload)
       SELECT $1, 'evt_06f_fb_' || g, 'invoice.payment_failed', 9999, 'mxn', 'failed', '{}'::jsonb FROM generate_series(1, 50) g`, [tenantB]);
  }, 120_000);

  const rango = () => ({ desde: inicioMesAnterior.toISOString(), hasta: new Date(Date.now() + 60_000).toISOString() });

  it('3/5/10/15 · 1,310 filas del libro → los grupos del servidor = agrupar en el cliente TODAS las filas; el KPI completo ≠ el recortado', async () => {
    const r = rango();
    const grupos = await comoAdmin<LibroGrupo>('SELECT * FROM libro_economico_agregado($1, $2, $3, $4)', [r.desde, r.desde, inicioMes.toISOString(), r.hasta]);
    const filas = await comoAdmin<LibroFila>('SELECT * FROM libro_economico($1, $2)', [r.desde, r.hasta]);
    expect(filas.length).toBeGreaterThan(CAP);
    expect(grupos.length).toBeLessThan(20); // unos pocos renglones, no miles
    const norm = (gs: LibroGrupo[]) => gs.map((g) => ({ ...g, monto_centavos: Number(g.monto_centavos), efecto_neto_centavos: Number(g.efecto_neto_centavos), n: Number(g.n) }))
      .sort((a, c) => JSON.stringify(a).localeCompare(JSON.stringify(c)));
    expect(norm(grupos)).toEqual(norm(agruparLibro(filas, inicioMes, inicioMesAnterior)));
    const completo = calcularCobradoAgregado(grupos);
    expect(completo).toEqual(calcularCobrado(filas, inicioMes, inicioMesAnterior, new Date(), []));
    expect(completo.cobradoMesCentavos).toBe(1100 * 10000 + (1100 * 1101) / 2);
    expect(completo.cobradoMesAnteriorCentavos).toBe(150 * 85000);
    expect(completo.sinResolverMes).toBe(60);
    expect(completo.porConcepto).toEqual([{ concepto: 'Paquetes', centavos: 1100 * 10000 + (1100 * 1101) / 2, cobros: 1100 }]);
    const recortado = calcularCobrado(filas.slice(0, CAP), inicioMes, inicioMesAnterior, new Date(), []);
    expect(recortado.cobradoMesCentavos + recortado.cobradoMesAnteriorCentavos).not.toBe(completo.cobradoMesCentavos + completo.cobradoMesAnteriorCentavos);
  });

  it('periodo: los cortes son los del cliente (mes / mes anterior / otro)', async () => {
    const r = rango();
    const antes = new Date(inicioMesAnterior.getTime() - 86_400_000).toISOString();
    const grupos = await comoAdmin<LibroGrupo>('SELECT * FROM libro_economico_agregado($1, $2, $3, $4)', [antes, r.desde, inicioMes.toISOString(), r.hasta]);
    expect(new Set(grupos.map((g) => g.periodo))).toEqual(new Set(['mes', 'mes_anterior']));
  });

  it('cobros fallidos: 1,200 en A (los nulos cuentan 0) y nada de B', async () => {
    const [f] = await comoAdmin<{ cobros: number; monto_centavos: string }>('SELECT * FROM cobros_fallidos_resumen($1)', [new Date(Date.now() - 30 * 86_400_000).toISOString()]);
    expect(f.cobros).toBe(1200);
    expect(Number(f.monto_centavos)).toBe(1080 * 5000);
  });
});

describe('FR-62/63 · membresías facturables por plan', () => {
  it('1,100 membresías vivas → los grupos dan el MISMO MRR que todas las filas; las primeras 1000 no', async () => {
    const tier = await b.tierId('pro-pack');
    await b.db.query(
      `WITH u AS (
         INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
         SELECT $1, 'm06f-' || g || '@test.mx', 'M' || g, 'miembro', 'activo' FROM generate_series(1, 1100) g RETURNING id)
       INSERT INTO membresias (usuario_id, tenant_id, tier_id, status)
       SELECT u.id, $1, $2, 'activa' FROM u`, [b.tenantId, tier]);
    const tiers = await b.filas<TierLite>(`SELECT id, slug, nombre, precio_centavos, periodo, moneda, tipo FROM tiers WHERE tenant_id = $1`, [b.tenantId]);
    const grupos = await comoAdmin<MembresiaLite>('SELECT * FROM membresias_vivas_por_tier()');
    const filas = await b.filas<MembresiaLite>(`SELECT tier_id, status FROM membresias WHERE tenant_id = $1 AND status IN ('activa','trialing','past_due') ORDER BY id`, [b.tenantId]);
    expect(filas.length).toBeGreaterThan(CAP);
    const completo = calcularEconomia(tiers, filas, 0);
    expect(calcularEconomia(tiers, grupos, 0)).toEqual(completo);
    expect(grupos.reduce((a, g) => a + Number(g.n), 0)).toBe(filas.length);
    expect(calcularEconomia(tiers, filas.slice(0, CAP), 0)).not.toEqual(completo);
  });
});

describe('reservas por día del estudio', () => {
  it('29/30 · día del estudio (America/Mazatlan): 23:30 local cuenta en ESE día, no en el siguiente UTC; canceladas fuera', async () => {
    const r1 = await b.reservar(miembro, await b.crearEstudio(), await b.slot(3, 12));
    const r2 = await b.reservar(miembro, await b.crearEstudio(), await b.slot(4, 12));
    // 2030-01-15 23:30 en Mazatlán = 2030-01-16 06:30 UTC.
    await b.db.query(`UPDATE reservas SET slot_inicio = '2030-01-16T06:30:00Z', slot_fin = '2030-01-16T07:30:00Z' WHERE id = $1`, [r1.reserva_id]);
    await b.db.query(`UPDATE reservas SET slot_inicio = '2030-01-16T07:30:00Z', slot_fin = '2030-01-16T08:30:00Z', status = 'cancelada' WHERE id = $1`, [r2.reserva_id]);
    const dias = await comoAdmin<{ dia: string; n: number }>(`SELECT dia::text, n FROM reservas_por_dia_estudio('2030-01-15T00:00:00Z', '2030-01-17T00:00:00Z')`);
    expect(dias).toEqual([{ dia: '2030-01-15', n: 1 }]);
  });

  it('23/24 · la RLS de reservas sigue mandando: un miembro solo cuenta lo suyo; otro estudio no ve nada de A', async () => {
    const otro = await b.crearPersona();
    const deOtro = await b.como(otro, () => b.filas(`SELECT * FROM reservas_por_dia_estudio('2030-01-15T00:00:00Z', '2030-01-17T00:00:00Z')`));
    expect(deOtro).toEqual([]);
  });
});

describe('autoridad', () => {
  it('20–23 · admin sí; recepción y miembro NO leen los agregados de admin (error, no ceros); anon sin EXECUTE', async () => {
    for (const p of [recep, miembro]) {
      await expect(b.como(p, () => b.filas('SELECT * FROM reporte_creditos()'))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
      await expect(b.como(p, () => b.filas(`SELECT * FROM cobros_fallidos_resumen(now() - interval '1 day')`))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
      await expect(b.como(p, () => b.filas('SELECT * FROM membresias_vivas_por_tier()'))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
      await expect(b.como(p, () => b.filas(`SELECT * FROM libro_economico_agregado(now() - interval '40 days', now() - interval '30 days', now() - interval '1 day', now())`))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    }
    const r = await b.fila<J>(`SELECT
      bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_x,
      bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_x,
      bool_or(p.prosecdef) AS alguno_definer,
      bool_and(p.proconfig @> ARRAY['search_path=public']) AS sp,
      count(*)::int AS n
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('reporte_creditos','libro_economico_agregado','cobros_fallidos_resumen','membresias_vivas_por_tier','reservas_por_dia_estudio')`);
    expect(r).toEqual({ anon_x: false, auth_x: true, alguno_definer: false, sp: true, n: 5 });
  });
});

describe('FR-65 · índice de membresia_movimientos por estudio', () => {
  it('16/17/18/19 · existe mov_tenant_fecha_idx (tenant_id, created_at DESC), es el ÚNICO que empieza por tenant_id y la consulta por estudio lo puede usar', async () => {
    const idx = await b.filas<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'membresia_movimientos'`);
    const porTenant = idx.filter((i) => /\(tenant_id[,)]/.test(i.indexdef));
    expect(porTenant.map((i) => i.indexname)).toEqual(['mov_tenant_fecha_idx']);
    await b.db.exec('SET enable_seqscan = off');
    const plan = (await b.filas<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT tipo, delta FROM membresia_movimientos WHERE tenant_id = '${b.tenantId}'`)).map((f) => f['QUERY PLAN']).join('\n');
    await b.db.exec('SET enable_seqscan = on');
    expect(plan).toMatch(/mov_tenant_fecha_idx/);
  });
});
