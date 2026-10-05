// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * Sprint D — acciones de mostrador sobre la membresía: ajustar créditos (M13) y
 * dar de baja (M14). Antes solo se resolvían con SQL o en el dashboard de Stripe.
 */

let b: BaseDePrueba;
let recep: Persona;

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
}, 120_000);

const ajustar = (actor: Persona, m: Persona, delta: number, motivo = 'Se cayó la luz a media sesión') =>
  b.como(actor, () =>
    b.fila<{ r: { creditos: number; creditos_antes: number } }>(
      'SELECT staff_ajustar_creditos($1, $2, $3) AS r',
      [m.id, delta, motivo]
    ).then((x) => x.r)
  );

const darDeBaja = (actor: Persona, m: Persona, inmediata: boolean, motivo = 'Se muda de ciudad') =>
  b.como(actor, () =>
    b.fila<{ r: Record<string, unknown> }>('SELECT staff_cancelar_membresia($1, $2, $3) AS r', [
      m.id,
      inmediata,
      motivo
    ]).then((x) => x.r)
  );

async function ledgerCuadra(m: Persona) {
  const r = await b.fila<{ saldo: number; suma: number }>(
    `SELECT mem.creditos_restantes AS saldo,
            (SELECT COALESCE(sum(delta), 0)::int FROM membresia_movimientos WHERE membresia_id = mem.id) AS suma
     FROM membresias mem
     WHERE mem.usuario_id = $1 AND mem.status IN ('trialing','activa','past_due','pausada')
     ORDER BY mem.created_at DESC LIMIT 1`,
    [m.id]
  );
  return r.saldo === r.suma;
}

describe('staff_ajustar_creditos', () => {
  it('abona créditos: saldo, asiento en el ledger, bitácora y aviso al miembro', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');

    const r = await ajustar(recep, m, 2);

    expect(r).toMatchObject({ creditos_antes: 12, creditos: 14 });
    expect(await b.creditos(m)).toBe(14);
    expect(await ledgerCuadra(m)).toBe(true);
    const audit = await b.fila<{ accion: string; motivo: string; actor_usuario_id: string }>(
      "SELECT accion, motivo, actor_usuario_id FROM audit_log WHERE target_id = $1 AND accion = 'creditos_ajustados'",
      [m.id]
    );
    expect(audit).toMatchObject({ motivo: 'Se cayó la luz a media sesión', actor_usuario_id: recep.id });
    const aviso = await b.fila<{ titulo: string }>(
      "SELECT titulo FROM notificaciones WHERE usuario_id = $1 AND tipo = 'creditos_ajustados'",
      [m.id]
    );
    expect(aviso.titulo).toMatch(/abonamos/i);
  });

  it('descuenta créditos, pero nunca por debajo de cero', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'sesion-suelta'); // 1

    await expect(ajustar(recep, m, -2)).rejects.toThrow(/EKKO_AJUSTE_INVALIDO/);
    await ajustar(recep, m, -1);

    expect(await b.creditos(m)).toBe(0);
    expect(await ledgerCuadra(m)).toBe(true);
  });

  it('sin motivo, con delta 0 o con un dedazo (500) → rechaza y no toca nada', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');

    await expect(ajustar(recep, m, 2, 'ok')).rejects.toThrow(/EKKO_MOTIVO_REQUERIDO/);
    await expect(ajustar(recep, m, 0)).rejects.toThrow(/EKKO_AJUSTE_INVALIDO/);
    await expect(ajustar(recep, m, 500)).rejects.toThrow(/EKKO_AJUSTE_INVALIDO/);

    expect(await b.creditos(m)).toBe(12);
  });

  it('plan mensual (sin créditos) o sin plan → mensaje claro', async () => {
    const mensual = await b.crearPersona();
    await b.activar(mensual, 'esencial');
    const sinPlan = await b.crearPersona();

    await expect(ajustar(recep, mensual, 1)).rejects.toThrow(/EKKO_PLAN_SIN_CREDITOS/);
    await expect(ajustar(recep, sinPlan, 1)).rejects.toThrow(/EKKO_SIN_MEMBRESIA/);
  });

  it('un miembro NO puede abonarse créditos, ni un recepcionista revocado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const revocado = await b.crearPersona({ rol: 'recepcionista', status: 'revocado' });

    await expect(ajustar(m, m, 5)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(ajustar(revocado, m, 5)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);

    expect(await b.creditos(m)).toBe(12);
  });

  it('también ajusta a un miembro en pausa', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'creador');
    await b.como(recep, () => b.fila('SELECT staff_pausar_membresia($1, true, $2)', [m.id, 'viaje']));

    await ajustar(recep, m, 1);

    const mem = await b.fila<{ creditos_restantes: number; status: string }>(
      'SELECT creditos_restantes, status FROM membresias WHERE usuario_id = $1',
      [m.id]
    );
    expect(mem).toEqual({ creditos_restantes: 7, status: 'pausada' });
  });
});

describe('staff_cancelar_membresia', () => {
  it('al fin del periodo (suscripción Stripe): marca la no-renovación y CONSERVA el acceso', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_baja_1', fin: '2099-01-01' });

    const r = await darDeBaja(recep, m, false);

    expect(r).toMatchObject({ inmediata: false, stripe_subscription_id: 'sub_baja_1' });
    const mem = await b.fila<{ status: string; cancel_at_period_end: boolean }>(
      'SELECT status, cancel_at_period_end FROM membresias WHERE usuario_id = $1',
      [m.id]
    );
    expect(mem).toEqual({ status: 'activa', cancel_at_period_end: true });
    expect(await b.estadoUsuario(m)).toMatchObject({ status: 'activo', membresia_tier: 'esencial' });
  });

  it('inmediata (mostrador, sin Stripe): cierra la membresía y suelta plan y acceso', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');

    await darDeBaja(recep, m, true);

    expect(await b.estadoUsuario(m)).toEqual({ status: 'cancelado', membresia_tier: null, con_activa: false });
    const audit = await b.fila<{ motivo: string }>(
      "SELECT motivo FROM audit_log WHERE target_id = $1 AND accion = 'membresia_baja'",
      [m.id]
    );
    expect(audit.motivo).toBe('Se muda de ciudad');
  });

  it('inmediata con créditos: la salida del saldo queda asentada, no desaparece', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');

    await darDeBaja(recep, m, true);

    const mov = await b.fila<{ delta: number; saldo_after: number }>(
      "SELECT delta, saldo_after FROM membresia_movimientos WHERE usuario_id = $1 AND motivo LIKE 'Baja de la membresía%'",
      [m.id]
    );
    expect(mov).toEqual({ delta: -12, saldo_after: 0 });
  });

  it('tras la baja inmediata puede volver a comprar el mismo plan', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await darDeBaja(recep, m, true);

    await b.activar(m, 'esencial');

    expect(await b.estadoUsuario(m)).toMatchObject({ status: 'activo', membresia_tier: 'esencial' });
  });

  it('da de baja a un miembro en pausa', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_baja_pausa', fin: '2099-01-01' });
    await b.como(recep, () => b.fila('SELECT staff_pausar_membresia($1, true, $2)', [m.id, 'viaje']));

    await darDeBaja(recep, m, true);

    expect((await b.estadoUsuario(m)).status).toBe('cancelado');
  });

  it('sin motivo, sin membresía, o por un miembro → rechaza', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    const sinPlan = await b.crearPersona();

    await expect(darDeBaja(recep, m, true, 'no')).rejects.toThrow(/EKKO_MOTIVO_REQUERIDO/);
    await expect(darDeBaja(recep, sinPlan, true)).rejects.toThrow(/EKKO_SIN_MEMBRESIA/);
    await expect(darDeBaja(m, m, true)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);

    expect((await b.estadoUsuario(m)).status).toBe('activo');
  });
});

describe('cancelación de una reserva por el estudio → bitácora', () => {
  it('recepción cancela: queda quién fue, el motivo y la reserva; el miembro que cancela la suya NO genera asiento', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio();
    const porStaff = await b.reservar(m, estudio, await b.slot(11));
    const porMiembro = await b.reservar(m, estudio, await b.slot(12));

    await b.como(recep, () => b.fila(`SELECT cancelar_reserva_atomic($1, $2, 'estudio')`, [porStaff.reserva_id, 'Falla del aire acondicionado']));
    await b.como(m, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [porMiembro.reserva_id, 'ya no puedo']));

    const asientos = await b.filas<{ actor_usuario_id: string; actor_rol: string; motivo: string; metadata: { reserva_id: string } }>(
      "SELECT actor_usuario_id, actor_rol, motivo, metadata FROM audit_log WHERE target_id = $1 AND accion = 'reserva_cancelada_por_estudio'",
      [m.id]
    );
    expect(asientos).toHaveLength(1);
    expect(asientos[0]).toMatchObject({
      actor_usuario_id: recep.id,
      actor_rol: 'recepcionista',
      motivo: 'Falla del aire acondicionado'
    });
    expect(asientos[0].metadata.reserva_id).toBe(porStaff.reserva_id);
  });
});
