// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-01D · registrar_venta_mostrador (migración 095) contra un Postgres real
 * (PGlite). Invariantes:
 *   NINGÚN éxito financiero sin evidencia durable.
 *   1 operation_id → MÁX 1 venta + MÁX 1 efecto de derecho (CLAIM → EXECUTE ONCE → REPLAY).
 *   La venta conserva el precio aplicado aunque cambie el catálogo.
 *   R1 (`activar_membresia`) no cambia: se invoca con referencia 'mostrador:<op>'.
 *
 * Concurrencia: PGlite es de UNA conexión, así que aquí NO se reproduce una
 * carrera real. Se prueba la semántica disponible (replay, binding, respaldo
 * único, rollback). En producción, `pg_advisory_xact_lock(hashtextextended(op))`
 * serializa dos transacciones del mismo operation_id: la segunda espera al
 * COMMIT/ROLLBACK de la primera y luego relee la fila (replay) o ejecuta fresca
 * si la primera se deshizo. Además `ventas_mostrador.operation_id UNIQUE` y
 * `membresias_referencia_pago_uniq` son respaldos independientes.
 */

let b: BaseDePrueba;
let staff: Persona;
let admin: Persona;

beforeAll(async () => {
  b = await levantarBase();
  staff = await b.crearPersona({ rol: 'recepcionista' });
  admin = await b.crearPersona({ rol: 'admin' });
}, 120_000);
afterAll(async () => {
  await b.db.close();
});

type Resultado = Record<string, unknown> & { venta_id?: string; membresia_id?: string; idempotente?: boolean };
type Venta = {
  id: string;
  operation_id: string;
  membresia_id: string | null;
  tier_slug: string;
  tier_nombre: string;
  tier_tipo: string;
  precio_lista_centavos: number;
  monto_cobrado_centavos: number;
  moneda: string;
  metodo: string;
  referencia: string | null;
  nota: string | null;
  actor_usuario_id: string;
  actor_rol: string;
};

let seq = 0;
const op = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

async function vender(
  actor: Persona,
  m: Persona,
  slug: string,
  o: { op?: string; metodo?: string; referencia?: string | null; nota?: string | null; confirmar?: boolean } = {}
): Promise<Resultado> {
  const r = await b.fila<{ r: Resultado }>(
    'SELECT registrar_venta_mostrador($1, $2, $3, (SELECT id FROM tiers WHERE slug = $4 AND tenant_id = $5), $6, $7, $8, $9) AS r',
    [o.op ?? op(), actor.id, m.id, slug, b.tenantId, o.metodo ?? 'efectivo', o.referencia ?? null, o.nota ?? null, o.confirmar ?? false]
  );
  return r.r;
}
const ventasDe = (m: Persona) =>
  b.filas<Venta>('SELECT * FROM ventas_mostrador WHERE usuario_id = $1 ORDER BY created_at, id', [m.id]);
const membresiasDe = (m: Persona) =>
  b.filas<{ id: string; status: string; creditos_restantes: number | null; referencia_pago: string | null; dias: number | null }>(
    `SELECT id, status, creditos_restantes, referencia_pago,
            round(extract(epoch FROM (periodo_actual_fin - now())) / 86400)::int AS dias
     FROM membresias WHERE usuario_id = $1 ORDER BY created_at, id`,
    [m.id]
  );
const movimientosDe = (m: Persona) =>
  b.filas<{ tipo: string; delta: number }>('SELECT tipo, delta FROM membresia_movimientos WHERE usuario_id = $1 ORDER BY created_at, id', [m.id]);
const usuario = (m: Persona) => b.fila<{ status: string; membresia_tier: string | null }>('SELECT status, membresia_tier FROM usuarios WHERE id = $1', [m.id]);

describe('venta feliz: evidencia + derecho en la MISMA transacción', () => {
  it('paquete en efectivo: una venta con snapshot, una membresía enlazada, precio derivado del catálogo', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const r = await vender(staff, m, 'creador', { referencia: 'folio 123', nota: 'pagó en caja' });
    expect(r).toMatchObject({ success: true, idempotente: false, metodo: 'efectivo', tier: 'creador', precio_lista_centavos: 115000, monto_cobrado_centavos: 115000, moneda: 'MXN' });
    const [v] = await ventasDe(m);
    expect(v).toMatchObject({
      operation_id: expect.any(String), membresia_id: r.membresia_id, tier_slug: 'creador', tier_nombre: 'Creador', tier_tipo: 'hibrido',
      precio_lista_centavos: 115000, monto_cobrado_centavos: 115000, moneda: 'MXN', metodo: 'efectivo', referencia: 'folio 123', nota: 'pagó en caja',
      actor_usuario_id: staff.id, actor_rol: 'recepcionista'
    });
    const mem = await membresiasDe(m);
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ status: 'activa', creditos_restantes: 6, referencia_pago: `mostrador:${v.operation_id}` });
    expect(await usuario(m)).toEqual({ status: 'activo', membresia_tier: 'creador' });
  });

  it('mensual por transferencia: monto = precio de lista; la membresía vive 1 mes', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const r = await vender(admin, m, 'esencial', { metodo: 'transferencia' });
    expect(r).toMatchObject({ precio_lista_centavos: 85000, monto_cobrado_centavos: 85000, metodo: 'transferencia' });
    const [mem] = await membresiasDe(m);
    expect(mem.status).toBe('activa');
    expect(mem.dias).toBeGreaterThanOrEqual(27);
    expect((await ventasDe(m))[0].actor_rol).toBe('admin');
  });
});

describe('D9 · cortesía', () => {
  it('conserva el precio de lista real y cobra 0; la membresía se activa igual', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const r = await vender(admin, m, 'esencial', { metodo: 'cortesia', nota: 'cortesía del dueño' });
    expect(r).toMatchObject({ precio_lista_centavos: 85000, monto_cobrado_centavos: 0, metodo: 'cortesia' });
    const [v] = await ventasDe(m);
    expect(v).toMatchObject({ precio_lista_centavos: 85000, monto_cobrado_centavos: 0 });
    expect((await membresiasDe(m))[0].status).toBe('activa');
  });

  it('el CHECK de la tabla impide una cortesía con monto o un cobro distinto del precio de lista', async () => {
    const m = await b.crearPersona();
    await expect(
      b.fila(
        `INSERT INTO ventas_mostrador (tenant_id, operation_id, usuario_id, tier_id, tier_slug, tier_nombre, tier_tipo,
           precio_lista_centavos, monto_cobrado_centavos, moneda, metodo, actor_usuario_id, actor_rol)
         VALUES ($1, $2, $3, (SELECT id FROM tiers WHERE slug = 'esencial' AND tenant_id = $1), 'esencial', 'Esencial', 'tiempo', 85000, 100, 'MXN', 'cortesia', $4, 'admin')`,
        [b.tenantId, op(), m.id, admin.id]
      )
    ).rejects.toThrow(/ventas_mostrador_monto_segun_metodo/);
    await expect(
      b.fila(
        `INSERT INTO ventas_mostrador (tenant_id, operation_id, usuario_id, tier_id, tier_slug, tier_nombre, tier_tipo,
           precio_lista_centavos, monto_cobrado_centavos, moneda, metodo, actor_usuario_id, actor_rol)
         VALUES ($1, $2, $3, (SELECT id FROM tiers WHERE slug = 'esencial' AND tenant_id = $1), 'esencial', 'Esencial', 'tiempo', 85000, 80000, 'MXN', 'efectivo', $4, 'admin')`,
        [b.tenantId, op(), m.id, admin.id]
      )
    ).rejects.toThrow(/ventas_mostrador_monto_segun_metodo/);
  });
});

describe('idempotencia · CLAIM → EXECUTE ONCE → REPLAY', () => {
  it('replay exacto: misma venta, misma membresía, UN solo efecto, idempotente=true', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const o = op();
    const a = await vender(staff, m, 'creador', { op: o });
    const r = await vender(staff, m, 'creador', { op: o });
    const r2 = await vender(staff, m, 'creador', { op: o });
    expect(a.idempotente).toBe(false);
    expect(r).toMatchObject({ success: true, idempotente: true, venta_id: a.venta_id, membresia_id: a.membresia_id, monto_cobrado_centavos: 115000, tier: 'creador' });
    expect(r2.venta_id).toBe(a.venta_id);
    expect(await ventasDe(m)).toHaveLength(1);
    const mem = await membresiasDe(m);
    expect(mem).toHaveLength(1);
    expect(mem[0].creditos_restantes).toBe(6); // no 12 ni 18
    expect((await movimientosDe(m)).filter((x) => x.tipo === 'alta')).toHaveLength(1);
  });

  it('replay de una mensualidad no apila otro mes', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const o = op();
    await vender(staff, m, 'esencial', { op: o });
    const antes = (await membresiasDe(m))[0].dias;
    await vender(staff, m, 'esencial', { op: o });
    const despues = await membresiasDe(m);
    expect(despues).toHaveLength(1);
    expect(despues[0].dias).toBe(antes);
  });

  it('replay conflictivo: el mismo operation_id NO adopta otro usuario, tier ni método → conflicto sin segundo efecto', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const otro = await b.crearPersona({ status: 'pendiente_pago' });
    const o = op();
    const a = await vender(staff, m, 'creador', { op: o, metodo: 'efectivo' });
    await expect(vender(staff, otro, 'creador', { op: o })).rejects.toThrow(/EKKO_OPERACION_MOSTRADOR_CONFLICTO/);
    await expect(vender(staff, m, 'esencial', { op: o })).rejects.toThrow(/EKKO_OPERACION_MOSTRADOR_CONFLICTO/);
    await expect(vender(staff, m, 'creador', { op: o, metodo: 'cortesia' })).rejects.toThrow(/EKKO_OPERACION_MOSTRADOR_CONFLICTO/);
    expect(await ventasDe(m)).toHaveLength(1);
    expect(await ventasDe(otro)).toHaveLength(0);
    expect((await membresiasDe(m))[0].id).toBe(a.membresia_id);
    expect(await membresiasDe(otro)).toHaveLength(0);
  });

  it('replay conflictivo por tenant: el operation_id de otro estudio no se adopta', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const o = op();
    await vender(staff, m, 'creador', { op: o });
    const t2 = await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('otro-estudio-01d', 'Otro', 'activo') RETURNING id`);
    const a2 = await b.fila<{ id: string }>(
      `INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-otro-01d@test.mx', '{"tenant_slug":"otro-estudio-01d","nombre":"Admin"}') RETURNING id`
    );
    const adminOtro = await b.fila<{ id: string }>(
      `UPDATE usuarios SET rol = 'admin', status = 'activo', tenant_id = $2 WHERE auth_id = $1 RETURNING id`,
      [a2.id, t2.id]
    );
    const tierOtro = await b.fila<{ id: string }>(
      `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, moneda, periodo, tipo, clases_incluidas, duracion_dias, activo)
       VALUES ($1, 'creador', 'Creador', 1000, 'MXN', 'mensual', 'hibrido', 1, 30, true) RETURNING id`,
      [t2.id]
    );
    const mOtro = await b.fila<{ id: string }>(
      `INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('m-otro-01d@test.mx', '{"tenant_slug":"otro-estudio-01d","nombre":"M"}') RETURNING id`
    ).then((a) => b.fila<{ id: string }>(`UPDATE usuarios SET tenant_id = $2, status = 'activo' WHERE auth_id = $1 RETURNING id`, [a.id, t2.id]));
    await expect(
      b.fila('SELECT registrar_venta_mostrador($1, $2, $3, $4, $5) AS r', [o, adminOtro.id, mOtro.id, tierOtro.id, 'efectivo'])
    ).rejects.toThrow(/EKKO_OPERACION_MOSTRADOR_CONFLICTO/);
    expect(await b.filas('SELECT id FROM ventas_mostrador WHERE tenant_id = $1', [t2.id])).toHaveLength(0);
  });

  it('respaldo: la referencia R1 "mostrador:<op>" es única en membresias', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const o = op();
    await vender(staff, m, 'creador', { op: o });
    const r = await b.fila<{ r: Record<string, unknown> }>(
      'SELECT activar_membresia($1, (SELECT id FROM tiers WHERE slug = $2 AND tenant_id = $3), NULL, NULL, NULL, $4, true) AS r',
      [m.id, 'creador', b.tenantId, `mostrador:${o}`]
    );
    expect(r.r.idempotente).toBe(true);
    expect((await membresiasDe(m))[0].creditos_restantes).toBe(6);
  });

  it('dos operation_id distintos son dos ventas legítimas con la semántica de R1 (créditos que se arrastran)', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const a = await vender(staff, m, 'creador');
    const c = await vender(staff, m, 'starter');
    expect(a.venta_id).not.toBe(c.venta_id);
    expect(await ventasDe(m)).toHaveLength(2);
    const mem = await membresiasDe(m);
    expect(mem.map((x) => x.status)).toEqual(['cancelada', 'activa']);
    expect(mem[1].creditos_restantes).toBe(9); // 6 arrastrados + 3
  });
});

describe('concurrencia · lo que PGlite sí puede probar', () => {
  it('el RPC toma un lock transaccional por operation_id ANTES de leer/escribir (serializa a dos requests iguales en producción)', async () => {
    const r = await b.fila<{ def: string }>(`SELECT pg_get_functiondef('registrar_venta_mostrador'::regproc) AS def`);
    const lock = r.def.indexOf('pg_advisory_xact_lock');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(r.def.indexOf('FROM ventas_mostrador WHERE operation_id'));
    expect(lock).toBeLessThan(r.def.indexOf('INSERT INTO ventas_mostrador'));
  });

  it('respaldo independiente: un segundo INSERT con el mismo operation_id viola el UNIQUE aunque el lock no existiera', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const o = op();
    await vender(staff, m, 'creador', { op: o });
    await expect(
      b.fila(
        `INSERT INTO ventas_mostrador (tenant_id, operation_id, usuario_id, tier_id, tier_slug, tier_nombre, tier_tipo,
           precio_lista_centavos, monto_cobrado_centavos, moneda, metodo, actor_usuario_id, actor_rol)
         VALUES ($1, $2, $3, (SELECT id FROM tiers WHERE slug = 'creador' AND tenant_id = $1), 'creador', 'Creador', 'hibrido', 115000, 115000, 'MXN', 'efectivo', $4, 'admin')`,
        [b.tenantId, o, m.id, admin.id]
      )
    ).rejects.toThrow(/ventas_mostrador_operation_id_key|duplicate key/);
    expect(await ventasDe(m)).toHaveLength(1);
  });
});

describe('rollback · si la activación falla no queda venta', () => {
  it('pérdida de créditos sin confirmar → EKKO_PERDERIA_CREDITOS: cero venta nueva, membresía intacta', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await vender(staff, m, 'creador');
    await expect(vender(staff, m, 'esencial', { confirmar: false })).rejects.toThrow(/EKKO_PERDERIA_CREDITOS/);
    expect(await ventasDe(m)).toHaveLength(1);
    const mem = await membresiasDe(m);
    expect(mem).toHaveLength(1);
    expect(mem[0]).toMatchObject({ status: 'activa', creditos_restantes: 6 });
    // El mismo op tras el fallo ejecuta fresco (no hubo efecto) cuando se confirma.
    const ok = await vender(staff, m, 'esencial', { confirmar: true });
    expect(ok.idempotente).toBe(false);
    expect(await ventasDe(m)).toHaveLength(2);
  });

  it('tier inactivo → sin venta ni membresía', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.fila(`UPDATE tiers SET activo = false WHERE slug = 'pro-pack' AND tenant_id = $1`, [b.tenantId]);
    await expect(vender(staff, m, 'pro-pack')).rejects.toThrow(/EKKO_TIER_INVALIDO/);
    await b.fila(`UPDATE tiers SET activo = true WHERE slug = 'pro-pack' AND tenant_id = $1`, [b.tenantId]);
    expect(await ventasDe(m)).toHaveLength(0);
    expect(await membresiasDe(m)).toHaveLength(0);
    expect((await usuario(m)).status).toBe('pendiente_pago');
  });
});

describe('snapshot · el catálogo cambia, la venta no', () => {
  it('subir el precio del plan después no altera precio_lista ni monto_cobrado de la venta', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await vender(staff, m, 'esencial');
    await b.fila(`UPDATE tiers SET precio_centavos = 99000, nombre = 'Esencial Plus' WHERE slug = 'esencial' AND tenant_id = $1`, [b.tenantId]);
    const [v] = await ventasDe(m);
    expect(v).toMatchObject({ precio_lista_centavos: 85000, monto_cobrado_centavos: 85000, tier_nombre: 'Esencial' });
    // Una venta NUEVA sí toma el precio vigente.
    const m2 = await b.crearPersona({ status: 'pendiente_pago' });
    expect((await vender(staff, m2, 'esencial')).precio_lista_centavos).toBe(99000);
    await b.fila(`UPDATE tiers SET precio_centavos = 85000, nombre = 'Esencial' WHERE slug = 'esencial' AND tenant_id = $1`, [b.tenantId]);
  });
});

describe('D-01D-3 · suscripción de Stripe viva', () => {
  it('rechaza ANTES de cualquier efecto y no cancela nada', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.activar(m, 'esencial', { id: 'sub_viva_01d' });
    await expect(vender(staff, m, 'creador')).rejects.toThrow(/EKKO_TIENE_SUSCRIPCION_STRIPE/);
    expect(await ventasDe(m)).toHaveLength(0);
    const mem = await membresiasDe(m);
    expect(mem).toHaveLength(1);
    expect(mem[0].status).toBe('activa');
  });

  it('una suscripción de Stripe ya cancelada no bloquea', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.activar(m, 'esencial', { id: 'sub_cancelada_01d' });
    await b.fila(`UPDATE membresias SET status = 'cancelada' WHERE usuario_id = $1`, [m.id]);
    const r = await vender(staff, m, 'creador');
    expect(r.success).toBe(true);
  });
});

describe('autorización · cero escritura', () => {
  it('un miembro no puede registrar ventas', async () => {
    const m = await b.crearPersona();
    const otro = await b.crearPersona({ status: 'pendiente_pago' });
    await expect(vender(m, otro, 'creador')).rejects.toThrow(/EKKO_ACTOR_NO_AUTORIZADO/);
    expect(await ventasDe(otro)).toHaveLength(0);
  });

  it('staff inactivo no puede', async () => {
    const inactivo = await b.crearPersona({ rol: 'recepcionista', status: 'suspendido' });
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await expect(vender(inactivo, m, 'creador')).rejects.toThrow(/EKKO_ACTOR_NO_AUTORIZADO/);
    expect(await ventasDe(m)).toHaveLength(0);
  });

  it('recepción no vende a una cuenta del equipo; un admin sí', async () => {
    const otroStaff = await b.crearPersona({ rol: 'recepcionista' });
    await expect(vender(staff, otroStaff, 'creador')).rejects.toThrow(/EKKO_ACTOR_NO_AUTORIZADO/);
    expect(await ventasDe(otroStaff)).toHaveLength(0);
    expect((await vender(admin, otroStaff, 'creador')).success).toBe(true);
  });

  it('método fuera del enum y operation_id nulo se rechazan sin escribir', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await expect(vender(staff, m, 'creador', { metodo: 'bitcoin' })).rejects.toThrow(/EKKO_METODO_INVALIDO/);
    await expect(
      b.fila('SELECT registrar_venta_mostrador(NULL, $1, $2, (SELECT id FROM tiers WHERE slug = $3 AND tenant_id = $4), $5) AS r', [staff.id, m.id, 'creador', b.tenantId, 'efectivo'])
    ).rejects.toThrow(/EKKO_OPERACION_INVALIDA/);
    expect(await ventasDe(m)).toHaveLength(0);
  });

  it('solo service_role ejecuta el RPC y solo el admin del tenant lee la tabla', async () => {
    const grants = await b.filas<{ grantee: string }>(
      `SELECT grantee FROM information_schema.routine_privileges WHERE routine_name = 'registrar_venta_mostrador' AND privilege_type = 'EXECUTE'`
    );
    const roles = grants.map((g) => g.grantee);
    expect(roles).toContain('service_role');
    expect(roles).not.toContain('authenticated');
    expect(roles).not.toContain('anon');
    const pol = await b.filas<{ policyname: string; cmd: string }>(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'ventas_mostrador'`);
    expect(pol).toEqual([{ policyname: 'ventas_mostrador_admin_read', cmd: 'SELECT' }]);
  });
});

describe('R1 intacto', () => {
  it('activar_membresia conserva su firma y sigue siendo solo de service_role', async () => {
    const r = await b.filas<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p WHERE p.proname = 'activar_membresia'`
    );
    expect(r).toHaveLength(1);
    expect(r[0].args).toBe('p_usuario_id uuid, p_tier_id uuid, p_stripe_subscription_id text, p_stripe_customer_id text, p_periodo_fin timestamp with time zone, p_referencia text, p_confirmar_perdida boolean');
  });
});
