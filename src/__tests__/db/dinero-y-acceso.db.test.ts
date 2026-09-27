// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * Tests CONDUCTUALES de dinero y acceso sobre un Postgres real (ver harness.ts).
 * Cada caso ejecuta las RPC de producción tal como las llama la app o el
 * webhook; ninguno mira el texto de una función.
 *
 * Cubre los hallazgos de SALA_PARITY_AUDIT_2 que nacieron en migraciones sin
 * red conductual: P0-1, P0-4, P0-5, S1, D1 y el trigger de débito (FK).
 */

let b: BaseDePrueba;

beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

const pasado = "now() - interval '1 day'";

async function vencerMembresia(p: Persona) {
  await b.db.query(
    `UPDATE membresias SET periodo_actual_fin = ${pasado}
     WHERE usuario_id = $1 AND status IN ('trialing','activa','past_due')`,
    [p.id]
  );
}

async function reservasDe(p: Persona): Promise<number> {
  const r = await b.fila<{ n: number }>(
    'SELECT count(*)::int AS n FROM reservas WHERE usuario_id = $1',
    [p.id]
  );
  return r.n;
}

describe('todas las migraciones aplican sobre una base limpia', () => {
  it('deja sembrado el tenant y sus planes', async () => {
    expect(b.tenantId).toBeTruthy();
    const planes = await b.filas<{ slug: string }>(
      'SELECT slug FROM tiers WHERE tenant_id = $1 AND activo',
      [b.tenantId]
    );
    expect(planes.map((p) => p.slug)).toEqual(
      expect.arrayContaining(['esencial', 'premium', 'pro-pack', 'sesion-suelta'])
    );
  });
});

describe('sync_membresia_stripe — la baja de una suscripción VIEJA no castiga al miembro', () => {
  it('mensual → compra un paquete → llega el deleted de la sub vieja: sigue activo con su paquete', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_vieja_1', fin: '2099-01-01' });
    await b.activar(m, 'pro-pack');

    const r = await b.fila<{ r: Record<string, unknown> }>(
      "SELECT sync_membresia_stripe('sub_vieja_1', 'cancelada', NULL, NULL, now()) AS r"
    );

    // F2 · R1: la sub vieja ya quedó `cancelada` localmente al activar el paquete,
    // así que el sync la trata como terminal y no toca nada (antes respondía
    // `usuario_intacto`). Lo que importa sigue igual: el miembro queda intacto.
    expect(r.r).toMatchObject({ success: true, ignorado: 'membresia_terminal', conflicto: false });
    expect(await b.estadoUsuario(m)).toEqual({
      status: 'activo',
      membresia_tier: 'pro-pack',
      con_activa: true
    });
    expect(await b.creditos(m)).toBe(12);
  });

  it('mensual → cambia a otro mensual → deleted de la sub vieja: sigue activo en el plan nuevo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_vieja_2', fin: '2099-01-01' });
    await b.activar(m, 'premium', { id: 'sub_nueva_2', fin: '2099-01-01' });

    await b.fila("SELECT sync_membresia_stripe('sub_vieja_2', 'cancelada', NULL, NULL, now())");

    expect(await b.estadoUsuario(m)).toEqual({
      status: 'activo',
      membresia_tier: 'premium',
      con_activa: true
    });
  });

  it('cancelación REAL (era su única membresía): corta el acceso y suelta membresía y tier', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_unica', fin: '2099-01-01' });

    await b.fila("SELECT sync_membresia_stripe('sub_unica', 'cancelada', NULL, NULL, now())");

    // membresia_tier = NULL es el fix de 20260704230000 que 20260821200000 perdió.
    expect(await b.estadoUsuario(m)).toEqual({
      status: 'cancelado',
      membresia_tier: null,
      con_activa: false
    });
  });

  it('un cancelado puede recomprar el MISMO plan y vuelve a quedar activo', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_a', fin: '2099-01-01' });
    await b.fila("SELECT sync_membresia_stripe('sub_a', 'cancelada', NULL, NULL, now())");

    await b.activar(m, 'esencial', { id: 'sub_b', fin: '2099-01-01' });

    expect(await b.estadoUsuario(m)).toEqual({
      status: 'activo',
      membresia_tier: 'esencial',
      con_activa: true
    });
  });
});

describe('reservar con paquete de créditos', () => {
  it('reserva, debita el costo del estudio y deja el asiento ligado a la reserva', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio([], 2);

    // Antes: "violates foreign key constraint membresia_movimientos_reserva_id_fkey"
    // (el trigger era BEFORE INSERT y la reserva aún no existía).
    const r = await b.reservar(m, estudio, await b.slot(3));

    expect(r.success).toBe(true);
    expect(await b.creditos(m)).toBe(10);
    const mov = await b.fila<{ delta: number; saldo_after: number }>(
      "SELECT delta, saldo_after FROM membresia_movimientos WHERE reserva_id = $1 AND tipo = 'debito'",
      [r.reserva_id]
    );
    expect(mov).toEqual({ delta: -2, saldo_after: 10 });
  });

  it('cancelar a tiempo devuelve el crédito', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio();
    const r = await b.reservar(m, estudio, await b.slot(5));
    expect(await b.creditos(m)).toBe(11);

    await b.como(m, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [r.reserva_id, 'test']));

    expect(await b.creditos(m)).toBe(12);
  });

  it('sin créditos suficientes: rechaza y no deja la reserva', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'sesion-suelta'); // 1 crédito
    const estudio = await b.crearEstudio([], 2);

    await expect(b.reservar(m, estudio, await b.slot(3, 14))).rejects.toThrow(/EKKO_SIN_CREDITOS/);

    expect(await reservasDe(m)).toBe(0);
    expect(await b.creditos(m)).toBe(1);
  });

  it('un slot ya ocupado no le debita nada al segundo', async () => {
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    const estudio = await b.crearEstudio();
    const slot = await b.slot(4);
    await b.reservar(a, estudio, slot);

    await expect(b.reservar(c, estudio, slot)).rejects.toThrow(/EKKO_SLOT_OCUPADO/);

    expect(await b.creditos(c)).toBe(12);
  });
});

describe('reservar exige una membresía viva (estudio abierto = tiers_permitidos vacío)', () => {
  it('miembro activo SIN plan: rechaza con EKKO_SIN_MEMBRESIA', async () => {
    const m = await b.crearPersona();
    const estudio = await b.crearEstudio();

    await expect(b.reservar(m, estudio, await b.slot(3))).rejects.toThrow(/EKKO_SIN_MEMBRESIA/);

    expect(await reservasDe(m)).toBe(0);
  });

  it('paquete expirado por el cron (status activo, tier NULL): rechaza', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'sesion-suelta');
    await vencerMembresia(m);
    await b.fila('SELECT expirar_membresias_vencidas()');
    expect(await b.estadoUsuario(m)).toMatchObject({ status: 'activo', membresia_tier: null });
    const estudio = await b.crearEstudio();

    await expect(b.reservar(m, estudio, await b.slot(3))).rejects.toThrow(/EKKO_SIN_MEMBRESIA/);
  });

  it('paquete vencido que el cron aún no barrió: EKKO_MEMBRESIA_VENCIDA', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    await vencerMembresia(m);
    const estudio = await b.crearEstudio();

    await expect(b.reservar(m, estudio, await b.slot(3))).rejects.toThrow(/EKKO_MEMBRESIA_VENCIDA/);
  });

  it('mensual de mostrador (sin Stripe) vencido: EKKO_MEMBRESIA_VENCIDA', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await vencerMembresia(m);
    const estudio = await b.crearEstudio();

    await expect(b.reservar(m, estudio, await b.slot(3))).rejects.toThrow(/EKKO_MEMBRESIA_VENCIDA/);
  });

  it('mensual con suscripción Stripe: manda el status, no la fecha (invoice.paid puede tardar)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_gracia', fin: '2099-01-01' });
    await vencerMembresia(m);
    const estudio = await b.crearEstudio();

    const r = await b.reservar(m, estudio, await b.slot(3));

    expect(r.success).toBe(true);
  });

  it('recepción tampoco puede reservarle a alguien sin plan; con plan sí', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const sinPlan = await b.crearPersona();
    const conPlan = await b.crearPersona();
    await b.activar(conPlan, 'pro-pack');
    const estudio = await b.crearEstudio();
    const para = (u: Persona, slot: string) =>
      b.como(recep, () =>
        b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60)', [u.id, estudio, slot])
      );

    await expect(para(sinPlan, await b.slot(6))).rejects.toThrow(/EKKO_SIN_MEMBRESIA/);
    await para(conPlan, await b.slot(6));

    expect(await reservasDe(conPlan)).toBe(1);
    expect(await b.creditos(conPlan)).toBe(11);
  });
});

describe('la duración de la reserva la fija el estudio, no el cliente', () => {
  it('un miembro no puede pedir 12 h por 1 crédito', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio();

    await expect(b.reservar(m, estudio, await b.slot(7, 9), 720)).rejects.toThrow(
      /EKKO_DURACION_INVALIDA/
    );

    expect(await reservasDe(m)).toBe(0);
    expect(await b.creditos(m)).toBe(12);
  });

  it('recepción puede conservar una duración distinta del default, pero no cruzar la medianoche', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'premium', { id: 'sub_dur', fin: '2099-01-01' });
    const estudio = await b.crearEstudio();
    const para = (slot: string, min: number) =>
      b.como(recep, () =>
        b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, $4)', [m.id, estudio, slot, min])
      );

    await para(await b.slot(8, 10), 120);
    expect(await reservasDe(m)).toBe(1);

    await expect(para(await b.slot(9, 21), 300)).rejects.toThrow(/EKKO_DURACION_INVALIDA/);
  });
});

describe('"Revocar acceso" revoca de verdad', () => {
  const soyRecepcion = (p: Persona) =>
    b.como(p, () =>
      b.fila<{ r: boolean; a: boolean; rol: string }>(
        'SELECT is_recepcionista() AS r, is_admin() AS a, get_my_rol() AS rol'
      )
    );
  const usuariosQueVe = (p: Persona) =>
    b.como(p, () => b.fila<{ n: number }>('SELECT count(*)::int AS n FROM usuarios')).then((x) => x.n);

  it('recepcionista activo: tiene poderes y ve el padrón', async () => {
    const r = await b.crearPersona({ rol: 'recepcionista' });
    await b.crearPersona();

    expect(await soyRecepcion(r)).toEqual({ r: true, a: false, rol: 'recepcionista' });
    expect(await usuariosQueVe(r)).toBeGreaterThan(1);
  });

  it('recepcionista revocado: sin poderes, rol "revocado" (no NULL), solo se ve a sí mismo y no reserva para terceros', async () => {
    const r = await b.crearPersona({ rol: 'recepcionista', status: 'revocado' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio();

    expect(await soyRecepcion(r)).toEqual({ r: false, a: false, rol: 'revocado' });
    expect(await usuariosQueVe(r)).toBe(1);
    await expect(
      b.como(r, async () =>
        b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60)', [
          m.id,
          estudio,
          await b.slot(10)
        ])
      )
    ).rejects.toThrow();
    expect(await reservasDe(m)).toBe(0);
  });

  it('admin revocado o suspendido: is_admin() = false', async () => {
    for (const status of ['revocado', 'suspendido']) {
      const a = await b.crearPersona({ rol: 'admin', status });
      expect(await soyRecepcion(a)).toEqual({ r: false, a: false, rol: 'revocado' });
    }
  });

  it('a un miembro no le cambia nada: conserva su rol aunque no esté activo', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    expect((await soyRecepcion(m)).rol).toBe('miembro');
  });
});

describe('CHECKs de planes: un paquete no nace vencido ni vacío', () => {
  const insertar = (campos: string, valores: string) =>
    b.db.query(
      `INSERT INTO tiers (tenant_id, slug, nombre, precio_centavos, ${campos})
       VALUES ('${b.tenantId}', 'x-' || gen_random_uuid(), 'X', 10000, ${valores})`
    );

  it('híbrido con vigencia de 0 días: rechazado', async () => {
    await expect(
      insertar('tipo, clases_incluidas, duracion_dias', "'hibrido', 4, 0")
    ).rejects.toThrow(/tiers_duracion_positiva/);
  });

  it('híbrido sin vigencia: rechazado', async () => {
    await expect(
      insertar('tipo, clases_incluidas, duracion_dias', "'hibrido', 4, NULL")
    ).rejects.toThrow(/tiers_hibrido_con_vigencia/);
  });

  it('paquete con 0 sesiones: rechazado', async () => {
    await expect(
      insertar('tipo, clases_incluidas, duracion_dias', "'hibrido', 0, 30")
    ).rejects.toThrow(/tiers_paquete_con_sesiones/);
  });

  it('un paquete bien formado sí entra', async () => {
    await insertar('tipo, clases_incluidas, duracion_dias', "'hibrido', 4, 30");
  });
});
