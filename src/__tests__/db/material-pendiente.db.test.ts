// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * Material pendiente: señal explícita (`reservas.material_requerido`, default
 * TRUE) + `staff_listar_material_pendiente()` (lo que alimenta el centro de
 * pendientes del dashboard y el filtro de Miembros).
 */

let b: BaseDePrueba;
let recep: Persona;

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
}, 120_000);

let dia = 2;
/** Sesión confirmada, con su `slot_fin` movido al pasado (ya "sucedió"). */
async function sesionPasada(opts: { status?: string; materialRequerido?: boolean } = {}) {
  const m = await b.crearPersona();
  await b.activar(m, 'pro-pack');
  const r = await b.reservar(m, await b.crearEstudio(), await b.slot(++dia, 17));
  await b.db.query(
    `UPDATE reservas SET slot_inicio = now() - interval '3 hours', slot_fin = now() - interval '2 hours',
       status = $2, material_requerido = COALESCE($3, material_requerido)
     WHERE id = $1`,
    [r.reserva_id, opts.status ?? 'completada', opts.materialRequerido ?? null]
  );
  return { m, reservaId: r.reserva_id };
}

const marcar = (actor: Persona, reservaId: string, requerido: boolean) =>
  b.como(actor, () => b.fila<{ r: Record<string, unknown> }>('SELECT staff_marcar_material_requerido($1, $2) AS r', [reservaId, requerido]).then((x) => x.r));

const pendientes = (actor: Persona) =>
  b.como(actor, () => b.filas<{ reserva_id: string }>('SELECT reserva_id FROM staff_listar_material_pendiente()'));

describe('reservas.material_requerido', () => {
  it('nace en TRUE (EKKO entrega el material salvo que alguien diga lo contrario)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(++dia, 10));
    const fila = await b.fila<{ material_requerido: boolean }>('SELECT material_requerido FROM reservas WHERE id = $1', [r.reserva_id]);
    expect(fila.material_requerido).toBe(true);
  });
});

describe('staff_marcar_material_requerido', () => {
  it('recepción lo apaga y lo vuelve a encender; queda auditado', async () => {
    const s = await sesionPasada();
    expect(await marcar(recep, s.reservaId, false)).toMatchObject({ success: true, material_requerido: false });
    let fila = await b.fila<{ material_requerido: boolean }>('SELECT material_requerido FROM reservas WHERE id = $1', [s.reservaId]);
    expect(fila.material_requerido).toBe(false);

    expect(await marcar(recep, s.reservaId, true)).toMatchObject({ success: true, material_requerido: true });
    fila = await b.fila<{ material_requerido: boolean }>('SELECT material_requerido FROM reservas WHERE id = $1', [s.reservaId]);
    expect(fila.material_requerido).toBe(true);

    const auditoria = await b.filas<{ despues: { material_requerido: boolean } }>(
      "SELECT despues FROM audit_log WHERE accion = 'material_requerido_cambiado' AND target_id = $1 ORDER BY creada_at",
      [s.m.id]
    );
    expect(auditoria.map((a) => a.despues.material_requerido)).toEqual([false, true]);
  });

  it('un MIEMBRO no puede marcarlo', async () => {
    const s = await sesionPasada();
    await expect(marcar(s.m, s.reservaId, false)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });

  it('reserva que no existe (o de otro tenant) → rechaza', async () => {
    await expect(marcar(recep, '00000000-0000-0000-0000-000000000000', false)).rejects.toThrow(/EKKO_RESERVA_NO_EXISTE/);
  });
});

describe('staff_listar_material_pendiente', () => {
  it('sesión pasada, requiere material, sin nada subido → SÍ aparece', async () => {
    const s = await sesionPasada();
    expect(await pendientes(recep)).toContainEqual({ reserva_id: s.reservaId });
  });

  it('material_requerido = false (el miembro trajo su propio equipo) → NO aparece', async () => {
    const s = await sesionPasada({ materialRequerido: false });
    expect(await pendientes(recep)).not.toContainEqual({ reserva_id: s.reservaId });
  });

  it('sesión cancelada o no-show → NO aparece', async () => {
    const cancelada = await sesionPasada({ status: 'cancelada' });
    const noShow = await sesionPasada({ status: 'no_show' });
    const lista = await pendientes(recep);
    expect(lista).not.toContainEqual({ reserva_id: cancelada.reservaId });
    expect(lista).not.toContainEqual({ reserva_id: noShow.reservaId });
  });

  it('sesión futura (status confirmada, aún no pasa) → NO aparece', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(++dia, 17));
    expect(await pendientes(recep)).not.toContainEqual({ reserva_id: r.reserva_id });
  });

  it('ya tiene material subido (archivo o enlace) → NO aparece', async () => {
    const s = await sesionPasada();
    await b.como(recep, () =>
      b.fila('SELECT staff_registrar_material($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        s.reservaId, 'enlace', 'Ya subido', null, 'https://ejemplo.com/x', null, null, null, null
      ])
    );
    expect(await pendientes(recep)).not.toContainEqual({ reserva_id: s.reservaId });
  });

  it('un MIEMBRO que llama la función no ve nada (ni lo suyo): es un reporte de staff', async () => {
    const s = await sesionPasada();
    expect(await pendientes(s.m)).toEqual([]);
  });
});
