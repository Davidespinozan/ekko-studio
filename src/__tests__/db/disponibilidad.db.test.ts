// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba } from './harness';

/**
 * A) El miembro VE los horarios ocupados por otros (sin saber por quién).
 * B) "Un solo set a la vez" — solicitud de cambios del cliente, punto 3.
 */

let b: BaseDePrueba;

beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

const dia = async (dias: number) => ({ desde: await b.slot(dias, 0), hasta: await b.slot(dias + 1, 0) });

describe('slots_ocupados — la grilla del miembro', () => {
  it('la tabla `reservas` NO le muestra las de otros (correcto)… y por eso la grilla las pintaba libres', async () => {
    const a = await b.crearPersona();
    const otro = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    const estudio = await b.crearEstudio();
    await b.reservar(a, estudio, await b.slot(3));

    const directo = await b.como(otro, () => b.filas('SELECT id FROM reservas WHERE recurso_id = $1', [estudio]));
    expect(directo).toHaveLength(0);

    const r = await dia(3);
    const ocupados = await b.ocupados(otro, estudio, r.desde, r.hasta);
    expect(ocupados).toHaveLength(1);
    expect(ocupados[0].mismo_set).toBe(true);
  });

  it('solo devuelve HORAS: ni quién reservó, ni folio, ni id', async () => {
    const a = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    const estudio = await b.crearEstudio();
    await b.reservar(a, estudio, await b.slot(4));
    const r = await dia(4);
    const [fila] = await b.ocupados(await b.crearPersona(), estudio, r.desde, r.hasta);
    expect(Object.keys(fila).sort()).toEqual(['mismo_set', 'slot_fin', 'slot_inicio']);
  });

  it('una reserva cancelada deja de ocupar', async () => {
    const a = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    const estudio = await b.crearEstudio();
    const res = await b.reservar(a, estudio, await b.slot(5));
    await b.como(a, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [res.reserva_id, 'x']));
    const r = await dia(5);
    expect(await b.ocupados(a, estudio, r.desde, r.hasta)).toHaveLength(0);
  });

  it('rechaza un rango desmedido (no es para exportar la agenda)', async () => {
    const a = await b.crearPersona();
    const estudio = await b.crearEstudio();
    await expect(b.ocupados(a, estudio, await b.slot(0, 0), await b.slot(200, 0))).rejects.toThrow(/EKKO_RANGO_INVALIDO/);
  });
});

describe('un solo set a la vez (reserva.sets_exclusivos)', () => {
  it('APAGADO: dos sets se pueden reservar a la misma hora', async () => {
    await b.setsExclusivos(false);
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    const slot = await b.slot(6);
    await b.reservar(a, await b.crearEstudio(), slot);
    await expect(b.reservar(c, await b.crearEstudio(), slot)).resolves.toMatchObject({ success: true });
  });

  it('ENCENDIDO: reservar el Set Podcast de 5 a 6 bloquea TODOS los demás sets de 5 a 6', async () => {
    await b.setsExclusivos(true);
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    const podcast = await b.crearEstudio();
    const otroSet = await b.crearEstudio();
    const slot = await b.slot(7, 17);
    await b.reservar(a, podcast, slot);

    await expect(b.reservar(c, otroSet, slot)).rejects.toThrow(/EKKO_ESTUDIO_EN_USO/);

    // No se cobró nada ni quedó reserva.
    expect(await b.creditos(c)).toBe(12);
    // Y la grilla del OTRO set ya lo muestra ocupado (por otro set).
    const r = await dia(7);
    const ocupados = await b.ocupados(c, otroSet, r.desde, r.hasta);
    expect(ocupados).toHaveLength(1);
    expect(ocupados[0].mismo_set).toBe(false);
  });

  it('ENCENDIDO: la hora siguiente (6 a 7) en otro set SÍ se puede', async () => {
    await b.setsExclusivos(true);
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    await b.reservar(a, await b.crearEstudio(), await b.slot(8, 17));
    await expect(b.reservar(c, await b.crearEstudio(), await b.slot(8, 18))).resolves.toMatchObject({ success: true });
  });

  it('ENCENDIDO: recepción tampoco puede encimar dos sets', async () => {
    await b.setsExclusivos(true);
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    const slot = await b.slot(9, 11);
    await b.reservar(a, await b.crearEstudio(), slot);
    const otroSet = await b.crearEstudio();
    await expect(
      b.como(recep, () => b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60)', [c.id, otroSet, slot]))
    ).rejects.toThrow(/EKKO_ESTUDIO_EN_USO/);
  });

  it('ENCENDIDO: al cancelar, el horario se libera para todos los sets', async () => {
    await b.setsExclusivos(true);
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    const slot = await b.slot(10, 13);
    const res = await b.reservar(a, await b.crearEstudio(), slot);
    await b.como(a, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [res.reserva_id, 'cambio']));
    await expect(b.reservar(c, await b.crearEstudio(), slot)).resolves.toMatchObject({ success: true });
  });

  it('ENCENDIDO: revivir una reserva cancelada encima de otro set también se rechaza', async () => {
    await b.setsExclusivos(true);
    const a = await b.crearPersona();
    const c = await b.crearPersona();
    await b.activar(a, 'pro-pack');
    await b.activar(c, 'pro-pack');
    const slot = await b.slot(11, 15);
    const vieja = await b.reservar(a, await b.crearEstudio(), slot);
    await b.como(a, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [vieja.reserva_id, 'cambio']));
    await b.reservar(c, await b.crearEstudio(), slot);

    await expect(
      b.db.query("UPDATE reservas SET status = 'completada' WHERE id = $1", [vieja.reserva_id])
    ).rejects.toThrow(/EKKO_ESTUDIO_EN_USO/);
  });

  it('la migración lo deja encendido para EKKO Studio', async () => {
    const limpia = await levantarBase({ comoLaDejaLaMigracion: true });
    const r = await limpia.fila<{ v: string }>("SELECT config->'reserva'->>'sets_exclusivos' AS v FROM tenants WHERE slug = 'ekko'");
    expect(r.v).toBe('true');
  }, 120_000);
});
