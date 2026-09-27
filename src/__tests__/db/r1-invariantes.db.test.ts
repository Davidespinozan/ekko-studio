// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * F2 · R1 — invariantes de membresía y observabilidad
 * (migración 20260927100000_r1_invariantes_membresia.sql).
 *
 *  · P0-1: la cuenta (revocación, sanción) se evalúa ANTES del atajo "la reserva
 *    ya se pagó con créditos". El crédito no se vuelve a descontar.
 *  · Check-in manual con restricción: permitido (política "QR bloquea, manual
 *    avisa") pero auditado como override.
 *  · sync de Stripe: sin resurrección de membresías terminales; orden de eventos
 *    que no descarta un evento distinto del mismo segundo.
 *  · Revocación persistente frente a todo el ciclo de membresía.
 *  · Auditoría con el estado real; vista de reconciliación.
 */

let b: BaseDePrueba;
let recep: Persona;
let admin: Persona;
let estudio: string;
let dia = 2;

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
  admin = await b.crearPersona({ rol: 'admin' });
  estudio = await b.crearEstudio();
}, 120_000);

// ── helpers ─────────────────────────────────────────────────────────────────
/** Reserva normal (≥24 h) y luego se acerca a "ahora" para caer en la ventana de check-in. */
async function reservaParaHoy(m: Persona): Promise<string> {
  // Estudio propio: varias reservas movidas a "ahora" chocarían en el EXCLUDE.
  const propio = await b.crearEstudio();
  const r = await b.reservar(m, propio, await b.slot(++dia));
  expect(r.success).toBe(true);
  await b.fila(
    "UPDATE reservas SET slot_inicio = now() + interval '5 minutes', slot_fin = now() + interval '65 minutes' WHERE id = $1",
    [r.reserva_id]
  );
  return r.reserva_id;
}
const checkInQR = (reservaId: string) =>
  b.como(recep, () => b.fila<{ r: Record<string, unknown> }>('SELECT check_in_atomic($1) AS r', [reservaId]).then((x) => x.r));
const checkInManual = (reservaId: string, motivo = 'Llegó sin celular') =>
  b.como(recep, () =>
    b.fila<{ r: Record<string, unknown> }>('SELECT check_in_manual_atomic($1, $2) AS r', [reservaId, motivo]).then((x) => x.r)
  );
const debitos = (reservaId: string) =>
  b.fila<{ n: number }>("SELECT count(*)::int AS n FROM membresia_movimientos WHERE reserva_id = $1 AND tipo = 'debito'", [reservaId]).then((x) => x.n);
const sancionar = (m: Persona) =>
  b.fila("UPDATE usuarios SET sancionado_at = now(), sancion_motivo = 'Daños al equipo' WHERE id = $1", [m.id]);
const revocar = (m: Persona) => b.fila("UPDATE usuarios SET status = 'revocado' WHERE id = $1", [m.id]);
const status = async (m: Persona) => (await b.estadoUsuario(m)).status;
const sync = (sub: string, estado: string, eventAt: string, cancelFin: boolean | null = null) =>
  b.fila<{ r: Record<string, unknown> }>(
    'SELECT sync_membresia_stripe($1, $2, NULL, $3, $4::timestamptz) AS r',
    [sub, estado, cancelFin, eventAt]
  ).then((x) => x.r);
const membresia = (sub: string) =>
  b.fila<{ status: string; cancel_at_period_end: boolean; last_sub_event_at: string }>(
    "SELECT status, cancel_at_period_end, to_char(last_sub_event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_sub_event_at FROM membresias WHERE stripe_subscription_id = $1",
    [sub]
  );
const pausar = (m: Persona, p: boolean) =>
  b.como(recep, () => b.fila<{ r: Record<string, unknown> }>('SELECT staff_pausar_membresia($1, $2, $3) AS r', [m.id, p, 'Viaje largo']).then((x) => x.r));
const auditDe = (m: Persona, accion: string) =>
  b.filas<{ antes: Record<string, unknown> | null; despues: Record<string, unknown> | null; metadata: Record<string, unknown> | null; actor_rol: string }>(
    'SELECT antes, despues, metadata, actor_rol FROM audit_log WHERE target_id = $1 AND accion = $2 ORDER BY creada_at',
    [m.id, accion]
  );
const reconciliacion = (m: Persona) =>
  b.fila<{ divergencias: string[]; restricciones: string[] }>(
    'SELECT divergencias, restricciones FROM v_reconciliacion_membresia WHERE usuario_id = $1',
    [m.id]
  );

// ── 1. P0-1 · QR check-in ───────────────────────────────────────────────────
describe('P0-1 · check-in por QR: la cuenta antes que el crédito ya pagado', () => {
  it('1–2. miembro válido + reserva pagada con créditos → entra, y el crédito no se descuenta otra vez', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    const antes = await b.creditos(m);
    expect(await debitos(reserva)).toBe(1);

    const r = await checkInQR(reserva);

    expect(r.success).toBe(true);
    expect(await debitos(reserva)).toBe(1);
    expect(await b.creditos(m)).toBe(antes);
  });

  it('1b. miembro con plan de tiempo (sin débito) sigue entrando', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    const r = await checkInQR(await reservaParaHoy(m));
    expect(r.success).toBe(true);
  });

  it('3/5. reserva pagada con créditos → sanción después → el QR NO deja entrar', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await sancionar(m);

    await expect(checkInQR(reserva)).rejects.toThrow(/EKKO_MEMBRESIA_NO_VIGENTE.*cuenta_sancionada/);
    expect(await debitos(reserva)).toBe(1);
  });

  it('4/6. reserva pagada con créditos → revocación después → el QR NO deja entrar', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await revocar(m);

    await expect(checkInQR(reserva)).rejects.toThrow(/EKKO_MEMBRESIA_NO_VIGENTE.*cuenta_revocado/);
  });

  it('una pausa (suspendido SIN sanción) con reserva ya pagada conserva su comportamiento: entra', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await pausar(m, true);
    expect(await status(m)).toBe('suspendido');

    const r = await checkInQR(reserva);
    expect(r.success).toBe(true);
  });
});

// ── 7. Check-in manual ──────────────────────────────────────────────────────
describe('7 · check-in manual: revocado BLOQUEADO; sancionado = override con aviso y audit', () => {
  it('revocado + manual → rechazado, SIN check-in persistido ni override registrado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await revocar(m);

    await expect(checkInManual(reserva)).rejects.toThrow(/EKKO_CUENTA_REVOCADA/);

    const r = await b.fila<{ status: string; check_in_at: string | null; check_in_method: string | null }>(
      'SELECT status, check_in_at, check_in_method FROM reservas WHERE id = $1', [reserva]
    );
    expect(r).toEqual({ status: 'confirmada', check_in_at: null, check_in_method: null });
    expect(await auditDe(m, 'checkin_manual_con_restriccion')).toHaveLength(0);
    expect(await debitos(reserva)).toBe(1);
  });

  it('revocado: la corrección manual "sí asistió" (UPDATE directo a completada manual) también se rechaza', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await revocar(m);
    await expect(
      b.fila("UPDATE reservas SET status = 'completada', check_in_at = now(), check_in_method = 'manual' WHERE id = $1", [reserva])
    ).rejects.toThrow(/EKKO_CUENTA_REVOCADA/);
  });

  it('restauración explícita → el acceso vuelve a regirse por la membresía: el QR deja entrar', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await revocar(m);
    await expect(checkInQR(reserva)).rejects.toThrow(/cuenta_revocado/);

    await b.fila("SELECT restaurar_acceso_revocado($1, $2, 'activo', 'Revocación por error')", [m.id, admin.id]);

    const r = await checkInQR(reserva);
    expect(r.success).toBe(true);
    expect(await debitos(reserva)).toBe(1);
  });

  it('sancionado: recepción puede darle ingreso, el RPC lo informa y queda en la bitácora como override', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const reserva = await reservaParaHoy(m);
    await sancionar(m);

    const r = await checkInManual(reserva);

    expect(r.success).toBe(true);
    expect(r.membresia_estado).toBe('cuenta_sancionada');
    const audit = await auditDe(m, 'checkin_manual_con_restriccion');
    expect(audit).toHaveLength(1);
    expect(audit[0].despues).toMatchObject({ membresia_estado: 'cuenta_sancionada' });
    expect(audit[0].metadata).toMatchObject({ reserva_id: reserva, override: true });
    expect(audit[0].actor_rol).toBe('recepcionista');
    expect(await debitos(reserva)).toBe(1);
  });

  it('miembro en regla: ingreso manual normal, SIN entrada de override', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await checkInManual(await reservaParaHoy(m));
    expect(r.membresia_estado).toBe('ok');
    expect(await auditDe(m, 'checkin_manual_con_restriccion')).toHaveLength(0);
  });
});

// ── 8–11 + 15–17 · sync de Stripe ───────────────────────────────────────────
describe('sync de Stripe: transiciones permitidas, sin resurrección, orden de eventos', () => {
  it('8–9. activa → past_due → activa siguen funcionando', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_pd', fin: '2099-01-01' });
    await sync('sub_r1_pd', 'past_due', '2026-10-01T00:00:00Z');
    expect((await membresia('sub_r1_pd')).status).toBe('past_due');
    await sync('sub_r1_pd', 'activa', '2026-10-02T00:00:00Z');
    expect((await membresia('sub_r1_pd')).status).toBe('activa');
    expect(await status(m)).toBe('activo');
  });

  it('10. membresía CANCELADA localmente + invoice.paid → no resucita; se registra la contradicción; respuesta determinista', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_canc', fin: '2099-01-01' });
    await sync('sub_r1_canc', 'cancelada', '2026-10-01T00:00:00Z');
    expect(await status(m)).toBe('cancelado');

    const r = await sync('sub_r1_canc', 'activa', '2026-10-05T00:00:00Z');

    expect(r).toMatchObject({ success: true, ignorado: 'membresia_terminal', conflicto: true });
    expect((await membresia('sub_r1_canc')).status).toBe('cancelada');
    expect(await status(m)).toBe('cancelado');
    const audit = await auditDe(m, 'stripe_estado_contradictorio');
    expect(audit).toHaveLength(1);
    expect(audit[0].despues).toMatchObject({ stripe_estado: 'activa' });
  });

  it('10b. una membresía reemplazada (cancelada por activar) no choca con el índice de una sola viva', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_vieja', fin: '2099-01-01' });
    await b.activar(m, 'premium', { id: 'sub_r1_nueva', fin: '2099-01-01' });
    expect((await membresia('sub_r1_vieja')).status).toBe('cancelada');

    // Antes: la resucitaba → unique violation → 500 y reintentos infinitos.
    const r = await sync('sub_r1_vieja', 'activa', '2026-10-05T00:00:00Z');

    expect(r).toMatchObject({ success: true, conflicto: true });
    expect((await membresia('sub_r1_nueva')).status).toBe('activa');
    expect((await b.estadoUsuario(m)).membresia_tier).toBe('premium');
  });

  it('11. membresía EXPIRADA + sync activa → no resucita', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_exp', fin: '2099-01-01' });
    await b.fila("UPDATE membresias SET status = 'expirada' WHERE stripe_subscription_id = 'sub_r1_exp'");

    const r = await sync('sub_r1_exp', 'activa', '2026-10-05T00:00:00Z');

    expect(r).toMatchObject({ success: true, conflicto: true });
    expect((await membresia('sub_r1_exp')).status).toBe('expirada');
  });

  it('una baja de Stripe sobre una membresía ya terminal no toca al miembro ni registra conflicto', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_doble', fin: '2099-01-01' });
    await sync('sub_r1_doble', 'cancelada', '2026-10-01T00:00:00Z');
    const r = await sync('sub_r1_doble', 'cancelada', '2026-10-02T00:00:00Z');
    expect(r).toMatchObject({ success: true, conflicto: false });
    expect(await auditDe(m, 'stripe_estado_contradictorio')).toHaveLength(0);
  });

  it('15. el mismo evento dos veces deja el mismo estado (y un solo cambio auditado)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_dup', fin: '2099-01-01' });
    const t = '2026-10-01T00:00:00Z';
    await sync('sub_r1_dup', 'past_due', t);
    await sync('sub_r1_dup', 'past_due', t);
    expect((await membresia('sub_r1_dup')).status).toBe('past_due');
    const cambios = (await auditDe(m, 'membresia_estado_cambio')).filter((a) => a.despues?.membresia_status === 'past_due');
    expect(cambios).toHaveLength(1);
  });

  it('16. dos eventos DISTINTOS del mismo segundo se aplican ambos (antes se descartaba el segundo)', async () => {
    await b.crearPersona().then((m) => b.activar(m, 'esencial', { id: 'sub_r1_mismo', fin: '2099-01-01' }));
    const t = '2026-10-01T12:00:00Z';
    await sync('sub_r1_mismo', 'past_due', t);             // invoice.payment_failed
    await sync('sub_r1_mismo', 'activa', t, true);         // subscription.updated (cancel al fin de periodo)
    const mem = await membresia('sub_r1_mismo');
    expect(mem.status).toBe('activa');
    expect(mem.cancel_at_period_end).toBe(true);
  });

  it('17. un evento realmente más viejo no pisa el estado más nuevo', async () => {
    await b.crearPersona().then((m) => b.activar(m, 'esencial', { id: 'sub_r1_viejo', fin: '2099-01-01' }));
    await sync('sub_r1_viejo', 'activa', '2026-10-05T00:00:00Z');
    const r = await sync('sub_r1_viejo', 'past_due', '2026-10-01T00:00:00Z');
    expect(r).toMatchObject({ skipped: 'evento_viejo' });
    const mem = await membresia('sub_r1_viejo');
    expect(mem.status).toBe('activa');
    expect(mem.last_sub_event_at).toMatch(/^2026-10-05/);
  });
});

// ── 12–14 · Revocación persistente ──────────────────────────────────────────
describe('revocación persistente frente al ciclo de membresía', () => {
  it('12. activar_membresia no levanta la revocación', async () => {
    const m = await b.crearPersona({ status: 'revocado' });
    await b.activar(m, 'esencial');
    expect(await status(m)).toBe('revocado');
  });

  it('13. sync de Stripe (activa, pausa y baja) no levanta ni convierte la revocación', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_rev', fin: '2099-01-01' });
    await revocar(m);
    await sync('sub_r1_rev', 'past_due', '2026-10-01T00:00:00Z');
    await sync('sub_r1_rev', 'activa', '2026-10-02T00:00:00Z');
    expect(await status(m)).toBe('revocado');
    await sync('sub_r1_rev', 'cancelada', '2026-10-03T00:00:00Z');
    expect(await status(m)).toBe('revocado'); // antes: 'cancelado' y la revocación se perdía
  });

  it('14. pausa y reanudación no levantan la revocación (antes la reanudación la pisaba)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await revocar(m);
    await pausar(m, true);
    expect(await status(m)).toBe('revocado');
    const r = await pausar(m, false);
    expect(await status(m)).toBe('revocado');
    expect(r.usuario_status).toBe('revocado');
    // El audit de la reanudación dice el estado REAL, no 'activo'.
    const audit = await auditDe(m, 'membresia_reactivada');
    expect(audit).toHaveLength(1);
    expect(audit[0].despues).toMatchObject({ usuario_status: 'revocado' });
  });

  it('baja inmediata por staff no convierte revocado en cancelado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await revocar(m);
    await b.como(recep, () => b.fila('SELECT staff_cancelar_membresia($1, true, $2)', [m.id, 'Se muda de ciudad']));
    expect(await status(m)).toBe('revocado');
  });

  it('un UPDATE directo (admin por RLS) tampoco levanta la revocación', async () => {
    const m = await b.crearPersona();
    await revocar(m);
    await b.como(admin, () => b.fila("UPDATE usuarios SET status = 'activo' WHERE id = $1", [m.id]));
    expect(await status(m)).toBe('revocado');
  });

  it('solo restaurar_acceso_revocado (admin activo, con motivo) la levanta, y queda auditado', async () => {
    const m = await b.crearPersona();
    await revocar(m);
    await expect(
      b.fila("SELECT restaurar_acceso_revocado($1, $2, 'activo', 'Error al revocar')", [m.id, recep.id])
    ).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(
      b.fila("SELECT restaurar_acceso_revocado($1, $2, 'activo', '')", [m.id, admin.id])
    ).rejects.toThrow(/EKKO_MOTIVO_REQUERIDO/);

    const r = await b.fila<{ r: Record<string, unknown> }>(
      "SELECT restaurar_acceso_revocado($1, $2, 'activo', 'Error al revocar') AS r",
      [m.id, admin.id]
    );
    expect(r.r).toMatchObject({ success: true, status: 'activo' });
    expect(await status(m)).toBe('activo');
    expect(await auditDe(m, 'acceso_restaurado')).toHaveLength(1);
  });

  it('la restauración no levanta una sanción vigente: queda suspendido y el audit lo dice', async () => {
    const m = await b.crearPersona();
    await sancionar(m);
    await revocar(m);
    const r = await b.fila<{ r: Record<string, unknown> }>(
      "SELECT restaurar_acceso_revocado($1, $2, 'activo', 'Revocación por error') AS r",
      [m.id, admin.id]
    );
    expect(r.r).toMatchObject({ status: 'suspendido' });
    expect((await auditDe(m, 'acceso_restaurado'))[0].despues).toMatchObject({ status: 'suspendido' });
  });

  it('un miembro no puede ejecutar restaurar_acceso_revocado', async () => {
    const m = await b.crearPersona();
    await revocar(m);
    const otro = await b.crearPersona();
    await expect(
      b.como(otro, () => b.fila("SELECT restaurar_acceso_revocado($1, $2, 'activo', 'hack')", [m.id, admin.id]))
    ).rejects.toThrow(/permission denied/);
  });
});

// ── 24–25 · F1 y ledger intactos ────────────────────────────────────────────
describe('F1 y ledger intactos', () => {
  it('24. sancionado + activación: la membresía existe, la cuenta sigue suspendida y el audit dice el estado REAL', async () => {
    const m = await b.crearPersona();
    await sancionar(m);
    await b.activar(m, 'esencial');
    expect(await status(m)).toBe('suspendido');
    // Toda entrada de cuenta registrada CON la sanción puesta dice 'suspendido', nunca 'activo'.
    const conSancion = (await auditDe(m, 'cuenta_estado_cambio')).filter((a) => a.despues?.sancionado === true);
    expect(conSancion.length).toBeGreaterThan(0);
    expect(conSancion.every((a) => a.despues?.status === 'suspendido')).toBe(true);
    expect(await auditDe(m, 'membresia_estado_cambio')).not.toHaveLength(0);
  });

  it('25. el ledger sigue cuadrando tras reserva, check-in y cancelación', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    await checkInQR(await reservaParaHoy(m));
    const r = await b.reservar(m, estudio, await b.slot(++dia));
    await b.como(m, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [r.reserva_id, 'No puedo']));
    const cuadre = await b.fila<{ saldo: number; suma: number }>(
      `SELECT mem.creditos_restantes AS saldo,
              (SELECT COALESCE(sum(delta), 0)::int FROM membresia_movimientos WHERE membresia_id = mem.id) AS suma
       FROM membresias mem WHERE mem.usuario_id = $1 AND mem.status = 'activa'`,
      [m.id]
    );
    expect(cuadre.saldo).toBe(cuadre.suma);
    expect(cuadre.saldo).toBe(11);
  });
});

// ── Auditoría del ciclo de vida ─────────────────────────────────────────────
describe('auditoría del ciclo de vida (estado real persistido)', () => {
  it('activación: alta de membresía y cambio de cuenta, con actor sistema cuando escribe el backend', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.activar(m, 'esencial');
    const mem = await auditDe(m, 'membresia_estado_cambio');
    expect(mem[0].despues).toMatchObject({ membresia_status: 'activa', tier: 'esencial' });
    expect(mem[0].actor_rol).toBe('sistema');
    const cuenta = await auditDe(m, 'cuenta_estado_cambio');
    expect(cuenta.some((a) => a.antes?.status === 'pendiente_pago' && a.despues?.status === 'activo' && a.actor_rol === 'sistema')).toBe(true);
  });

  it('revocación y cambio de rol quedan auditados con el actor de la sesión', async () => {
    const m = await b.crearPersona();
    await b.como(admin, () => b.fila("UPDATE usuarios SET status = 'revocado' WHERE id = $1", [m.id]));
    const rev = await auditDe(m, 'cuenta_estado_cambio');
    expect(rev.some((a) => a.actor_rol === 'admin' && a.despues?.status === 'revocado')).toBe(true);

    const s = await b.crearPersona();
    await b.como(admin, () => b.fila("UPDATE usuarios SET rol = 'recepcionista' WHERE id = $1", [s.id]));
    const rol = await auditDe(s, 'cuenta_estado_cambio');
    expect(rol.some((a) => a.antes?.rol === 'miembro' && a.despues?.rol === 'recepcionista')).toBe(true);
  });

  it('cambio de plan (tier_id) queda auditado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_plan', fin: '2099-01-01' });
    await b.fila(
      "UPDATE membresias SET tier_id = (SELECT id FROM tiers WHERE slug = 'premium' AND tenant_id = $1) WHERE stripe_subscription_id = 'sub_r1_plan'",
      [b.tenantId]
    );
    const cambio = (await auditDe(m, 'membresia_estado_cambio')).find((a) => a.antes?.tier === 'esencial');
    expect(cambio?.despues).toMatchObject({ tier: 'premium' });
  });
});

// ── 21–23 · Vista de reconciliación ─────────────────────────────────────────
describe('v_reconciliacion_membresia (solo lectura)', () => {
  it('21. cuenta activa sin membresía viva → activo_sin_derecho', async () => {
    const m = await b.crearPersona();
    expect((await reconciliacion(m)).divergencias).toContain('activo_sin_derecho');
  });

  it('22. tier sin membresía (incluido staff) → tier_sin_membresia_viva', async () => {
    const s = await b.crearPersona({ rol: 'admin' });
    await b.fila("UPDATE usuarios SET membresia_tier = 'premium' WHERE id = $1", [s.id]);
    const r = await reconciliacion(s);
    expect(r.divergencias).toContain('tier_sin_membresia_viva');
    expect(r.divergencias).not.toContain('activo_sin_derecho'); // staff: no se le exige membresía
  });

  it('23. sancionado o revocado con membresía viva → RESTRICCIÓN, no divergencia; la membresía se conserva', async () => {
    const s = await b.crearPersona();
    await b.activar(s, 'esencial');
    await sancionar(s);
    const r = await reconciliacion(s);
    expect(r.restricciones).toContain('sancionado_con_membresia_viva');
    expect(r.divergencias).toEqual([]);

    const v = await b.crearPersona();
    await b.activar(v, 'esencial');
    await revocar(v);
    expect((await reconciliacion(v)).restricciones).toContain('revocado_con_membresia_viva');
  });

  it('miembro en regla → sin divergencias ni restricciones', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    expect(await reconciliacion(m)).toEqual({ divergencias: [], restricciones: [] });
  });

  it('contradicción de Stripe registrada → stripe_contradictorio', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_r1_vista', fin: '2099-01-01' });
    await sync('sub_r1_vista', 'cancelada', '2026-10-01T00:00:00Z');
    await sync('sub_r1_vista', 'activa', '2026-10-02T00:00:00Z');
    expect((await reconciliacion(m)).divergencias).toContain('stripe_contradictorio');
  });

  it('respeta RLS: un miembro solo ve su fila; anon no tiene acceso', async () => {
    const m = await b.crearPersona();
    const filas = await b.como(m, () => b.filas<{ usuario_id: string }>('SELECT usuario_id FROM v_reconciliacion_membresia'));
    expect(filas.map((f) => f.usuario_id)).toEqual([m.id]);
    await b.db.exec('SET ROLE anon;');
    try {
      await expect(b.filas('SELECT 1 FROM v_reconciliacion_membresia')).rejects.toThrow(/permission denied/);
    } finally {
      await b.db.exec('RESET ROLE;');
    }
  });
});
