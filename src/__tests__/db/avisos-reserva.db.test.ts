// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * Solicitud del cliente, punto 4: confirmación al reservar y avisos de los cambios
 * relevantes, por la app y por correo (`email_enviado_at` lo consume cron-email).
 */

let b: BaseDePrueba;
beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

const avisos = (p: Persona, tipo: string) =>
  b.filas<{ titulo: string; mensaje: string; metadata: Record<string, string>; email_enviado_at: string | null; push_enviado_at: string | null }>(
    'SELECT titulo, mensaje, metadata, email_enviado_at, push_enviado_at FROM notificaciones WHERE usuario_id = $1 AND tipo = $2',
    [p.id, tipo]
  );

describe('confirmación de reserva', () => {
  it('al reservar queda el aviso con set, fecha y hora DEL ESTUDIO, duración, folio y el enlace al QR — pendiente de correo y de push', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio();
    const r = await b.reservar(m, estudio, await b.slot(3, 17));

    const [aviso] = await avisos(m, 'reserva_confirmada');
    expect(aviso.titulo).toBe('Reserva confirmada');
    expect(aviso.mensaje).toMatch(/^Tienes set-prueba-\d+ el \S+ \d+ de \S+, 17:00 \(60 min\)\. Folio EKK-\d+\. Muestra tu QR al llegar\.$/);
    expect(aviso.metadata.url).toBe(`/app/qr/${r.reserva_id}`);
    expect(aviso.email_enviado_at).toBeNull();
    expect(aviso.push_enviado_at).toBeNull();
  });

  it('si la agenda recepción, el miembro también se entera ("Te agendamos…")', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const estudio = await b.crearEstudio();
    await b.como(recep, async () =>
      b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60)', [m.id, estudio, await b.slot(4, 10)])
    );
    const [aviso] = await avisos(m, 'reserva_confirmada');
    expect(aviso.mensaje).toMatch(/^Te agendamos /);
  });

  it('una reserva RECHAZADA (sin plan) no deja ningún aviso', async () => {
    const m = await b.crearPersona();
    const estudio = await b.crearEstudio();
    await expect(b.reservar(m, estudio, await b.slot(5))).rejects.toThrow();
    expect(await avisos(m, 'reserva_confirmada')).toHaveLength(0);
  });
});

describe('cancelación', () => {
  it('el miembro cancela la suya: constancia propia (antes no quedaba nada)', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(6, 9));
    await b.como(m, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [r.reserva_id, 'cambio de planes']));

    const [aviso] = await avisos(m, 'reserva_cancelada_por_ti');
    expect(aviso.mensaje).toMatch(/^Cancelaste set-prueba-\d+ del .*, 09:00\. El horario quedó libre\.$/);
    expect(await avisos(m, 'reserva_cancelada')).toHaveLength(0);
  });

  it('cancela el estudio: UN aviso, con la hora del ESTUDIO (antes salía en UTC) y el motivo', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(7, 16)); // 16:00 Mazatlán = 23:00 UTC
    await b.como(recep, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [r.reserva_id, 'Falla eléctrica']));

    const lista = await avisos(m, 'reserva_cancelada');
    expect(lista).toHaveLength(1);
    expect(lista[0].mensaje).toContain(', 16:00 fue cancelada por el estudio. Motivo: Falla eléctrica');
    expect(lista[0].mensaje).not.toContain('23:00');
    expect(await avisos(m, 'reserva_cancelada_por_ti')).toHaveLength(0);
  });
});

describe('_fecha_hora_estudio', () => {
  it('formatea en español y en la zona del estudio', async () => {
    const r = await b.fila<{ t: string }>("SELECT _fecha_hora_estudio('2026-09-22T00:30:00Z') AS t");
    expect(r.t).toBe('lunes 21 de septiembre, 17:30');
  });
});

describe('reprogramar = UN aviso de cambio de horario', () => {
  it('sustituye el par "te agendamos" + "cancelada por el estudio" por uno solo, de dónde a dónde', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const setA = await b.crearEstudio();
    const setB = await b.crearEstudio();
    const vieja = await b.reservar(m, setA, await b.slot(20, 10));
    // Lo que hace recepción al reprogramar: crear la nueva y cancelar la vieja.
    await b.como(recep, async () =>
      b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60)', [m.id, setB, await b.slot(21, 16)])
    );
    await b.como(recep, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [vieja.reserva_id, 'Reprogramada por recepción']));

    const r = await b.como(recep, () => b.fila<{ r: { success: boolean } }>('SELECT staff_avisar_reprogramacion($1) AS r', [vieja.reserva_id]));

    expect(r.r.success).toBe(true);
    expect(await avisos(m, 'reserva_cancelada')).toHaveLength(0);
    // Queda la confirmación ORIGINAL de la vieja (de cuando la reservó); la de la nueva se retiró.
    expect((await avisos(m, 'reserva_confirmada')).every((a) => a.metadata.reserva_id === vieja.reserva_id)).toBe(true);
    const [cambio, ...resto] = await avisos(m, 'reserva_reprogramada');
    expect(resto).toHaveLength(0);
    expect(cambio.mensaje).toMatch(/^Era set-prueba-\d+ el .*, 10:00\. Ahora es set-prueba-\d+ el .*, 16:00 \(60 min\)\./);
    expect(cambio.metadata.url).toMatch(/^\/app\/qr\//);
    expect(cambio.email_enviado_at).toBeNull();
  });

  it('si no hubo reprogramación (la vieja no está cancelada por el estudio) no toca nada', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r0 = await b.reservar(m, await b.crearEstudio(), await b.slot(22, 10));
    const r = await b.como(recep, () => b.fila<{ r: { success: boolean } }>('SELECT staff_avisar_reprogramacion($1) AS r', [r0.reserva_id]));
    expect(r.r.success).toBe(false);
    expect(await avisos(m, 'reserva_confirmada')).toHaveLength(1);
  });

  it('un miembro no puede llamarla', async () => {
    const m = await b.crearPersona();
    await expect(b.como(m, () => b.fila('SELECT staff_avisar_reprogramacion(gen_random_uuid())'))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });
});
