// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-01F · migración 096 contra un Postgres real (PGlite):
 *   reservas_incompatibles_con_tier → detecta (no cancela) reservas futuras que el
 *     tier destino no permitiría: estudio fuera de tiers_permitidos o más
 *     invitados que reglas.max_invitados. Solo del miembro consultado.
 *   cambiar_tier_membresia → transición mensual→mensual atómica e idempotente por
 *     operation_id: membresias.tier_id + usuarios.membresia_tier + audit_log en
 *     una transacción; R1 intacto (no llama activar_membresia, no crea membresía).
 * Concurrencia real no se reproduce en PGlite (una conexión): se prueba replay,
 * binding y rollback; el advisory lock transaccional serializa en producción.
 */

let b: BaseDePrueba;
let seq = 0;
const op = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

beforeAll(async () => {
  b = await levantarBase();
}, 120_000);
afterAll(async () => {
  await b.db.close();
});

type Res = Record<string, unknown> & { success?: boolean; idempotente?: boolean; tier?: string; tier_anterior?: string };

async function mensual(slug: string, subId: string): Promise<Persona> {
  const m = await b.crearPersona({ status: 'pendiente_pago' });
  await b.activar(m, slug, { id: subId, fin: new Date(Date.now() + 20 * 86_400_000).toISOString() });
  return m;
}
const membresiaViva = (m: Persona) =>
  b.fila<{ id: string; tier_id: string; status: string; stripe_subscription_id: string | null }>(
    `SELECT id, tier_id, status, stripe_subscription_id FROM membresias WHERE usuario_id = $1 AND status IN ('trialing','activa','past_due','pausada')`,
    [m.id]
  );
const cambiar = (o: string, m: Persona, memId: string, slug: string, sub: string, resumen: Record<string, unknown> = {}, actor: string | null = null) =>
  b.fila<{ r: Res }>(
    'SELECT cambiar_tier_membresia($1, $2, $3, (SELECT id FROM tiers WHERE slug = $4 AND tenant_id = $5), $6, $7::jsonb, $8) AS r',
    [o, m.id, memId, slug, b.tenantId, sub, JSON.stringify(resumen), actor ?? m.id]
  ).then((x) => x.r);
const incompatibles = (m: Persona, slug: string) =>
  b.fila<{ r: Array<Record<string, unknown>> }>(
    'SELECT reservas_incompatibles_con_tier($1, (SELECT id FROM tiers WHERE slug = $2 AND tenant_id = $3)) AS r',
    [m.id, slug, b.tenantId]
  ).then((x) => x.r);
const usuario = (m: Persona) => b.fila<{ membresia_tier: string | null; status: string }>('SELECT membresia_tier, status FROM usuarios WHERE id = $1', [m.id]);
const audits = (m: Persona) =>
  b.filas<{ antes: Record<string, unknown>; despues: Record<string, unknown>; metadata: Record<string, unknown>; actor_rol: string }>(
    `SELECT antes, despues, metadata, actor_rol FROM audit_log WHERE accion = 'plan_cambiado' AND target_id = $1 ORDER BY creada_at, id`,
    [m.id]
  );

describe('reservas_incompatibles_con_tier · solo detecta', () => {
  it('compatible → lista vacía; estudio fuera del plan destino → estudio_no_permitido; solo reservas futuras confirmadas del miembro', async () => {
    const m = await mensual('premium', 'sub_g1');
    const otro = await mensual('premium', 'sub_g1b');
    const abierto = await b.crearEstudio([]);
    const soloPremium = await b.crearEstudio(['premium']);
    const r1 = await b.reservar(m, abierto, await b.slot(2));
    const r2 = await b.reservar(m, soloPremium, await b.slot(3));
    await b.reservar(otro, soloPremium, await b.slot(4)); // de otro miembro: no debe aparecer
    expect(r1.success && r2.success).toBe(true);

    expect(await incompatibles(m, 'premium')).toEqual([]);
    const lista = await incompatibles(m, 'esencial');
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ reserva_id: r2.reserva_id, folio: r2.folio, motivo: 'estudio_no_permitido' });
    // Cancelada → ya no cuenta.
    await b.fila(`UPDATE reservas SET status = 'cancelada' WHERE id = $1`, [r2.reserva_id]);
    expect(await incompatibles(m, 'esencial')).toEqual([]);
    // Nada se modificó.
    expect((await b.fila<{ n: string }>(`SELECT count(*)::text n FROM reservas WHERE usuario_id = $1 AND status = 'confirmada'`, [m.id])).n).toBe('1');
  });

  it('invitados por encima de max_invitados del destino → invitados_exceden', async () => {
    const m = await mensual('premium', 'sub_g2'); // premium: 4 invitados
    const abierto = await b.crearEstudio([]);
    const slot = await b.slot(5);
    const r = await b.como(m, () =>
      b.fila<{ r: { success: boolean; reserva_id: string } }>('SELECT reservar_recurso_atomic($1, $2::timestamptz, $3, $4) AS r', [abierto, slot, 60, 3]).then((x) => x.r)
    );
    expect(r.success).toBe(true);
    const lista = await incompatibles(m, 'esencial'); // esencial: 2 invitados
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ reserva_id: r.reserva_id, invitados: 3, motivo: 'invitados_exceden' });
    expect(await incompatibles(m, 'premium')).toEqual([]);
  });

  it('tier inexistente → EKKO_TIER_INVALIDO; solo service_role puede ejecutarla', async () => {
    const m = await mensual('esencial', 'sub_g3');
    await expect(b.fila('SELECT reservas_incompatibles_con_tier($1, gen_random_uuid())', [m.id])).rejects.toThrow(/EKKO_TIER_INVALIDO/);
    const grants = await b.filas<{ grantee: string }>(`SELECT grantee FROM information_schema.routine_privileges WHERE routine_name IN ('reservas_incompatibles_con_tier','cambiar_tier_membresia') AND privilege_type = 'EXECUTE'`);
    expect(grants.map((g) => g.grantee)).not.toContain('authenticated');
    expect(grants.map((g) => g.grantee)).toContain('service_role');
  });
});

describe('cambiar_tier_membresia · transición atómica e idempotente', () => {
  it('cambia tier_id y el slug cacheado juntos y deja evidencia con anterior → destino, sub, operación y resumen', async () => {
    const m = await mensual('esencial', 'sub_c1');
    const mem = await membresiaViva(m);
    const o = op();
    const r = await cambiar(o, m, mem.id, 'premium', 'sub_c1', { direccion: 'upgrade', amount_paid: 35000, invoice_id: 'in_x' });
    expect(r).toMatchObject({ success: true, idempotente: false, membresia_id: mem.id, tier_anterior: 'esencial', tier: 'premium' });
    const despues = await membresiaViva(m);
    expect(despues.id).toBe(mem.id); // la MISMA membresía; no se creó otra
    expect(despues.tier_id).toBe(await b.tierId('premium'));
    expect((await usuario(m)).membresia_tier).toBe('premium');
    const a = await audits(m);
    expect(a).toHaveLength(1);
    expect(a[0].antes).toMatchObject({ tier_slug: 'esencial', precio_centavos: 85000 });
    expect(a[0].despues).toMatchObject({ tier_slug: 'premium' });
    expect(a[0].metadata).toMatchObject({ operation_id: o, membresia_id: mem.id, stripe_subscription_id: 'sub_c1', stripe: { direccion: 'upgrade', amount_paid: 35000, invoice_id: 'in_x' } });
    expect(a[0].actor_rol).toBe('miembro');
  });

  it('replay exacto → misma respuesta con idempotente=true, una sola evidencia, sin segundo efecto', async () => {
    const m = await mensual('esencial', 'sub_c2');
    const mem = await membresiaViva(m);
    const o = op();
    await cambiar(o, m, mem.id, 'premium', 'sub_c2');
    const r = await cambiar(o, m, mem.id, 'premium', 'sub_c2');
    expect(r).toMatchObject({ success: true, idempotente: true, membresia_id: mem.id, tier: 'premium', tier_anterior: 'esencial' });
    expect(await audits(m)).toHaveLength(1);
    expect((await b.filas('SELECT id FROM membresias WHERE usuario_id = $1', [m.id]))).toHaveLength(1);
  });

  it('replay conflictivo: el mismo operation_id con otro destino u otra membresía → EKKO_OPERACION_CONFLICTO', async () => {
    const m = await mensual('esencial', 'sub_c3');
    const mem = await membresiaViva(m);
    const o = op();
    await cambiar(o, m, mem.id, 'premium', 'sub_c3');
    await expect(cambiar(o, m, mem.id, 'esencial', 'sub_c3')).rejects.toThrow(/EKKO_OPERACION_CONFLICTO/);
    expect((await membresiaViva(m)).tier_id).toBe(await b.tierId('premium'));
  });

  it('un operation_id de OTRO usuario no recupera ni aplica nada para este', async () => {
    const a = await mensual('esencial', 'sub_c4a');
    const c = await mensual('esencial', 'sub_c4c');
    const o = op();
    await cambiar(o, a, (await membresiaViva(a)).id, 'premium', 'sub_c4a');
    // Mismo UUID para c: el replay busca por target = c → no hay; ejecuta su propio cambio con su propia sub.
    const r = await cambiar(o, c, (await membresiaViva(c)).id, 'premium', 'sub_c4c');
    expect(r.idempotente).toBe(false);
    expect(await audits(a)).toHaveLength(1);
    expect(await audits(c)).toHaveLength(1);
  });

  it('rollback: sub que no corresponde, membresía de otro, membresía no activa o destino paquete → nada cambia', async () => {
    const m = await mensual('esencial', 'sub_c5');
    const otro = await mensual('esencial', 'sub_c5b');
    const mem = await membresiaViva(m);
    await expect(cambiar(op(), m, mem.id, 'premium', 'sub_otra')).rejects.toThrow(/EKKO_SUSCRIPCION_INVALIDA/);
    await expect(cambiar(op(), m, (await membresiaViva(otro)).id, 'premium', 'sub_c5b')).rejects.toThrow(/EKKO_MEMBRESIA_INVALIDA/);
    await expect(cambiar(op(), m, mem.id, 'creador', 'sub_c5')).rejects.toThrow(/EKKO_TIER_INVALIDO/);
    await b.fila(`UPDATE membresias SET status = 'past_due' WHERE id = $1`, [mem.id]);
    await expect(cambiar(op(), m, mem.id, 'premium', 'sub_c5')).rejects.toThrow(/EKKO_MEMBRESIA_NO_ACTIVA/);
    await b.fila(`UPDATE membresias SET status = 'activa' WHERE id = $1`, [mem.id]);
    expect((await membresiaViva(m)).tier_id).toBe(await b.tierId('esencial'));
    expect((await usuario(m)).membresia_tier).toBe('esencial');
    expect(await audits(m)).toHaveLength(0);
  });

  it('R1 manda: revocado y sancionado no cambian de plan; nunca resucita ni crea una segunda membresía', async () => {
    const m = await mensual('esencial', 'sub_c6');
    const mem = await membresiaViva(m);
    await b.fila(`UPDATE usuarios SET sancionado_at = now(), status = 'suspendido' WHERE id = $1`, [m.id]);
    await expect(cambiar(op(), m, mem.id, 'premium', 'sub_c6')).rejects.toThrow(/EKKO_CUENTA_RESTRINGIDA/);
    await b.fila(`UPDATE usuarios SET sancionado_at = NULL, status = 'revocado' WHERE id = $1`, [m.id]);
    await expect(cambiar(op(), m, mem.id, 'premium', 'sub_c6')).rejects.toThrow(/EKKO_CUENTA_RESTRINGIDA/);
    expect((await usuario(m)).status).toBe('revocado');
    expect((await b.filas('SELECT id FROM membresias WHERE usuario_id = $1', [m.id]))).toHaveLength(1);
  });

  it('el lock por operación va antes de cualquier lectura o escritura (serializa dos requests iguales en producción)', async () => {
    const def = (await b.fila<{ d: string }>(`SELECT pg_get_functiondef('cambiar_tier_membresia'::regproc) d`)).d;
    const lock = def.indexOf('pg_advisory_xact_lock');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(def.indexOf('FROM audit_log'));
    expect(lock).toBeLessThan(def.indexOf('UPDATE membresias'));
    expect(def).not.toMatch(/activar_membresia/);
  });

  it('R1 intacto: activar_membresia y sync_membresia_stripe conservan su firma', async () => {
    const r = await b.filas<{ proname: string; args: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) args FROM pg_proc p WHERE p.proname IN ('activar_membresia','sync_membresia_stripe') ORDER BY 1`
    );
    expect(r.map((x) => x.proname)).toEqual(['activar_membresia', 'sync_membresia_stripe']);
    expect(r[0].args).toBe('p_usuario_id uuid, p_tier_id uuid, p_stripe_subscription_id text, p_stripe_customer_id text, p_periodo_fin timestamp with time zone, p_referencia text, p_confirmar_perdida boolean');
  });
});
