// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * Sprint C de SALA_PARITY_AUDIT_2 — dinero: M2 (doble acreditación), M3 (recompra
 * que acorta la vigencia), M4 (pausa), M5 (un cobro no levanta una sanción),
 * M12 (pérdida de créditos confirmada en servidor) y D10 (devolución al saldo
 * correcto). Todo contra un Postgres real (ver harness.ts).
 */

let b: BaseDePrueba;

beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

type Mem = {
  id: string;
  status: string;
  creditos_restantes: number | null;
  dias: number | null;
};

/** Membresías del miembro, de la más nueva a la más vieja; `dias` = vigencia restante. */
function membresias(p: Persona) {
  return b.filas<Mem>(
    `SELECT id, status, creditos_restantes,
            round(extract(epoch FROM (periodo_actual_fin - now())) / 86400)::int AS dias
     FROM membresias WHERE usuario_id = $1 ORDER BY created_at DESC, id`,
    [p.id]
  );
}
const vivas = async (p: Persona) =>
  (await membresias(p)).filter((m) => ['trialing', 'activa', 'past_due', 'pausada'].includes(m.status));

function activarPago(p: Persona, slug: string, referencia: string | null, confirmarPerdida = true) {
  return b
    .fila<{ r: Record<string, unknown> }>(
      'SELECT activar_membresia($1, (SELECT id FROM tiers WHERE slug = $2), NULL, $3, NULL, $4, $5) AS r',
      [p.id, slug, referencia ? 'cus_test' : null, referencia, confirmarPerdida]
    )
    .then((x) => x.r);
}

const pausar = (staff: Persona, m: Persona, pausar: boolean) =>
  b.como(staff, () =>
    b.fila<{ r: Record<string, unknown> }>('SELECT staff_pausar_membresia($1, $2, $3) AS r', [
      m.id,
      pausar,
      'viaje de trabajo'
    ])
  );

describe('M2 — un pago único acredita UNA vez', () => {
  it('checkout.session.completed + payment_intent.succeeded del mismo pago = 1 paquete, no 2', async () => {
    const m = await b.crearPersona();

    const primero = await activarPago(m, 'creador', 'pi_mismo_pago');
    const segundo = await activarPago(m, 'creador', 'pi_mismo_pago');

    expect(primero).toMatchObject({ success: true, creditos: 6 });
    expect(segundo).toMatchObject({ success: true, idempotente: true, membresia_id: primero.membresia_id });
    expect(await b.creditos(m)).toBe(6);
    expect(await membresias(m)).toHaveLength(1);
  });

  it('el reintento llega cuando el paquete ya se reemplazó por otro: tampoco se vuelve a acreditar', async () => {
    const m = await b.crearPersona();
    await activarPago(m, 'creador', 'pi_viejo');
    await activarPago(m, 'pro-pack', 'pi_nuevo'); // 6 + 12

    const reintento = await activarPago(m, 'creador', 'pi_viejo');

    expect(reintento).toMatchObject({ idempotente: true });
    expect(await b.creditos(m)).toBe(18);
  });

  it('dos compras DISTINTAS sí suman', async () => {
    const m = await b.crearPersona();
    await activarPago(m, 'creador', 'pi_a');
    await activarPago(m, 'creador', 'pi_b');
    expect(await b.creditos(m)).toBe(12);
  });

  it('el ledger reconcilia con el saldo tras el reintento', async () => {
    const m = await b.crearPersona();
    await activarPago(m, 'creador', 'pi_ledger');
    await activarPago(m, 'creador', 'pi_ledger');
    const viva = (await vivas(m))[0];
    const suma = await b.fila<{ s: number }>(
      'SELECT COALESCE(sum(delta), 0)::int AS s FROM membresia_movimientos WHERE membresia_id = $1',
      [viva.id]
    );
    expect(suma.s).toBe(viva.creditos_restantes);
  });
});

describe('M3 — recomprar no acorta lo que ya se tenía', () => {
  it('pro-pack (120 d) + sesión suelta (30 d): 13 créditos que siguen valiendo ~120 días', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');

    await b.activar(m, 'sesion-suelta');

    const [viva] = await vivas(m);
    expect(viva.creditos_restantes).toBe(13);
    expect(viva.dias).toBeGreaterThanOrEqual(119); // antes: 30
  });

  it('al revés, un paquete más largo sí EXTIENDE', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'sesion-suelta');
    await b.activar(m, 'pro-pack');
    expect((await vivas(m))[0].dias).toBeGreaterThanOrEqual(119);
  });

  it('un saldo ya VENCIDO no se revive ni estira la fecha', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    await b.db.query(
      "UPDATE membresias SET periodo_actual_fin = now() - interval '1 day' WHERE usuario_id = $1",
      [m.id]
    );

    await b.activar(m, 'sesion-suelta');

    const [viva] = await vivas(m);
    expect(viva.creditos_restantes).toBe(1);
    expect(viva.dias).toBeLessThanOrEqual(30);
  });

  it('mensual de mostrador renovado antes de vencer: apila desde su fin, no desde hoy', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await b.db.query(
      "UPDATE membresias SET periodo_actual_fin = now() + interval '10 days' WHERE usuario_id = $1",
      [m.id]
    );

    await b.activar(m, 'esencial');

    expect((await vivas(m))[0].dias).toBeGreaterThanOrEqual(38); // 10 + ~1 mes; antes ~30
  });

  it('cambiar a OTRO plan mensual no hereda los días del anterior', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await b.db.query(
      "UPDATE membresias SET periodo_actual_fin = now() + interval '25 days' WHERE usuario_id = $1",
      [m.id]
    );
    await b.activar(m, 'premium');
    expect((await vivas(m))[0].dias).toBeLessThanOrEqual(31);
  });
});

describe('M12 — perder créditos por cambiar de plan exige confirmación en el servidor', () => {
  it('paquete con saldo → mensual, sin confirmar: rechaza y no toca nada', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');

    await expect(activarPago(m, 'esencial', null, false)).rejects.toThrow(/EKKO_PERDERIA_CREDITOS.*12/);

    expect(await b.creditos(m)).toBe(12);
    expect(await b.estadoUsuario(m)).toMatchObject({ membresia_tier: 'pro-pack' });
  });

  it('confirmado: cambia de plan y el ledger asienta la pérdida', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    await activarPago(m, 'esencial', null, true);

    expect(await b.estadoUsuario(m)).toMatchObject({ membresia_tier: 'esencial' });
    const cierre = await b.fila<{ delta: number }>(
      "SELECT delta FROM membresia_movimientos WHERE usuario_id = $1 AND motivo = 'Cierre de membresía anterior'",
      [m.id]
    );
    expect(cierre.delta).toBe(-12);
  });

  it('paquete → otro paquete nunca pide confirmación (el saldo se arrastra)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'creador');
    await activarPago(m, 'pro-pack', null, false);
    expect(await b.creditos(m)).toBe(18);
  });
});

describe('M4 — la pausa', () => {
  it('reanudar devuelve los días que estuvo en pausa (paquete sin Stripe)', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'sesion-suelta'); // 30 días
    await pausar(recep, m, true);
    // Simula 21 días en pausa.
    await b.db.query(
      "UPDATE membresias SET pausada_at = now() - interval '21 days' WHERE usuario_id = $1",
      [m.id]
    );

    await pausar(recep, m, false);

    const [viva] = await vivas(m);
    expect(viva.status).toBe('activa');
    expect(viva.dias).toBeGreaterThanOrEqual(50); // 30 + 21; antes 30 (y 9 "reales")
    expect(viva.creditos_restantes).toBe(1);
    expect(await b.estadoUsuario(m)).toMatchObject({ status: 'activo', con_activa: true });
  });

  it('con suscripción Stripe el periodo NO se toca (lo dicta Stripe)', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_pausa_stripe', fin: '2099-01-01' });
    await pausar(recep, m, true);
    await b.db.query(
      "UPDATE membresias SET pausada_at = now() - interval '21 days' WHERE usuario_id = $1",
      [m.id]
    );
    const antes = (await vivas(m))[0].dias;

    await pausar(recep, m, false);

    expect((await vivas(m))[0].dias).toBe(antes);
  });

  it('una past_due pausada vuelve como past_due, no blanqueada a activa', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_debe', fin: '2099-01-01' });
    await b.fila("SELECT sync_membresia_stripe('sub_debe', 'past_due', NULL, NULL, now())");
    await pausar(recep, m, true);

    await pausar(recep, m, false);

    expect((await vivas(m))[0].status).toBe('past_due');
  });

  it('activarle otro plan a un miembro en pausa NO deja dos membresías vivas y arrastra su saldo', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'creador'); // 6
    await pausar(recep, m, true);

    await b.activar(m, 'pro-pack'); // +12

    const v = await vivas(m);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ status: 'activa', creditos_restantes: 18 });
    expect(await b.estadoUsuario(m)).toMatchObject({ status: 'activo', membresia_tier: 'pro-pack' });
  });

  it('el estudio cancela una reserva de un miembro en pausa: el crédito vuelve', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(5));
    expect(await b.creditos(m)).toBe(11);
    await pausar(recep, m, true);

    await b.como(recep, () => b.fila(`SELECT cancelar_reserva_atomic($1, $2, 'estudio')`, [r.reserva_id, 'falla de equipo']));

    expect((await vivas(m))[0]).toMatchObject({ status: 'pausada', creditos_restantes: 12 });
  });
});

describe('D10 — la devolución vuelve al saldo que pagó', () => {
  it('reservó con un paquete, luego compró otro: la devolución cae en el paquete vivo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'creador'); // 6
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(6)); // 5
    await b.activar(m, 'pro-pack'); // 5 + 12 = 17

    await b.como(m, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [r.reserva_id, 'cambio de planes']));

    expect(await b.creditos(m)).toBe(18);
  });
});

describe('M5 — un cobro no levanta una sanción', () => {
  async function conSub(sub: string, status: string) {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: sub, fin: '2099-01-01' });
    await b.db.query('UPDATE usuarios SET status = $2 WHERE id = $1', [m.id, status]);
    return m;
  }
  const cobroOk = (sub: string) =>
    b.fila(`SELECT sync_membresia_stripe('${sub}', 'activa', '2099-02-01', NULL, now())`);

  it('suspendido por el admin: invoice.paid NO lo reactiva', async () => {
    const m = await conSub('sub_sancion', 'suspendido');
    await cobroOk('sub_sancion');
    expect((await b.estadoUsuario(m)).status).toBe('suspendido');
  });

  it('revocado: tampoco', async () => {
    const m = await conSub('sub_revocado', 'revocado');
    await cobroOk('sub_revocado');
    expect((await b.estadoUsuario(m)).status).toBe('revocado');
  });

  it('cancelado o pendiente de pago: el cobro SÍ le devuelve el acceso', async () => {
    const a = await conSub('sub_cancelado', 'cancelado');
    const p = await conSub('sub_pendiente', 'pendiente_pago');
    await cobroOk('sub_cancelado');
    await cobroOk('sub_pendiente');
    expect((await b.estadoUsuario(a)).status).toBe('activo');
    expect((await b.estadoUsuario(p)).status).toBe('activo');
  });

  it('suspendido por la PAUSA de esa misma membresía: al reanudarse en Stripe vuelve a activo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_pausa_sync', fin: '2099-01-01' });
    await b.fila("SELECT sync_membresia_stripe('sub_pausa_sync', 'pausada', NULL, NULL, now())");
    expect((await b.estadoUsuario(m)).status).toBe('suspendido');

    await b.fila("SELECT sync_membresia_stripe('sub_pausa_sync', 'activa', NULL, NULL, now() + interval '1 second')");

    expect((await b.estadoUsuario(m)).status).toBe('activo');
  });
});
