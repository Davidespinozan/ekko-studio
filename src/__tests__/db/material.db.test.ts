// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/** Solicitud del cliente, punto 5: entrega y descarga del material de cada sesión. */

let b: BaseDePrueba;
let recep: Persona;

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
}, 120_000);

let dia = 2;
async function sesion() {
  const m = await b.crearPersona();
  await b.activar(m, 'pro-pack');
  const r = await b.reservar(m, await b.crearEstudio(), await b.slot(++dia, 17));
  return { m, reservaId: r.reserva_id, carpeta: `${b.tenantId}/${m.id}/${r.reserva_id}` };
}

const registrar = (actor: Persona, args: Record<string, unknown>) =>
  b.como(actor, () =>
    b.fila<{ r: { material_id: string; disponible_hasta: string | null } }>(
      `SELECT staff_registrar_material($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r`,
      [args.reserva, args.tipo, args.titulo ?? 'Episodio 1', args.path ?? null, args.url ?? null,
       args.nombre ?? null, args.tamano ?? null, args.mime ?? null, args.dias ?? null]
    ).then((x) => x.r)
  );

const loQueVe = (p: Persona) =>
  b.como(p, () => b.filas<{ titulo: string; tipo: string }>('SELECT titulo, tipo FROM material_sesion ORDER BY created_at'));

/** ¿Puede este usuario leer el objeto en Storage? (= firmar su URL de descarga) */
const puedeLeerObjeto = (p: Persona, ruta: string) =>
  b.como(p, () => b.filas('SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2', ['material', ruta])).then((f) => f.length > 0);

describe('subir material a una sesión', () => {
  it('archivo y enlace quedan ligados a la reserva y al dueño de la sesión; vigencia por defecto de 30 días', async () => {
    const s = await sesion();
    const a = await registrar(recep, { reserva: s.reservaId, tipo: 'archivo', titulo: 'Video final', path: `${s.carpeta}/abc-final.mp4`, nombre: 'final.mp4', tamano: 1_500_000, mime: 'video/mp4' });
    await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', titulo: 'Material en bruto (Drive)', url: 'https://drive.google.com/drive/folders/xyz' });

    expect(await loQueVe(s.m)).toEqual([
      { titulo: 'Video final', tipo: 'archivo' },
      { titulo: 'Material en bruto (Drive)', tipo: 'enlace' }
    ]);
    const dias = (new Date(a.disponible_hasta!).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(dias)).toBe(30);
    const fila = await b.fila<{ usuario_id: string; subido_por: string }>('SELECT usuario_id, subido_por FROM material_sesion WHERE id = $1', [a.material_id]);
    expect(fila).toEqual({ usuario_id: s.m.id, subido_por: recep.id });
  });

  it('dias = 0 → sin vencimiento; el estudio puede fijar otra vigencia por defecto', async () => {
    const s = await sesion();
    const sinVencer = await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/a', dias: 0 });
    expect(sinVencer.disponible_hasta).toBeNull();

    await b.db.query(`UPDATE tenants SET config = jsonb_set(config, '{material}', '{"dias_disponible": 7}') WHERE id = $1`, [b.tenantId]);
    const siete = await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/b' });
    expect(Math.round((new Date(siete.disponible_hasta!).getTime() - Date.now()) / 86_400_000)).toBe(7);
    await b.db.query(`UPDATE tenants SET config = config #- '{material}' WHERE id = $1`, [b.tenantId]);
  });

  it('el archivo tiene que estar en la carpeta de ESA reserva: no se le "entrega" a un miembro el archivo de otro', async () => {
    const s = await sesion();
    const otra = await sesion();
    await expect(
      registrar(recep, { reserva: s.reservaId, tipo: 'archivo', path: `${otra.carpeta}/robado.mp4` })
    ).rejects.toThrow(/EKKO_RUTA_INVALIDA/);
  });

  it('enlace sin https, sesión cancelada, o un MIEMBRO intentando subir → rechaza', async () => {
    const s = await sesion();
    await expect(registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'http://inseguro.com/x' })).rejects.toThrow(/EKKO_ENLACE_INVALIDO/);
    await expect(registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'javascript:alert(1)' })).rejects.toThrow(/EKKO_ENLACE_INVALIDO/);
    await expect(registrar(s.m, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com' })).rejects.toThrow(/EKKO_NO_AUTORIZADO/);

    await b.como(recep, () => b.fila('SELECT cancelar_reserva_atomic($1, $2)', [s.reservaId, 'se canceló']));
    await expect(registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com' })).rejects.toThrow(/EKKO_RESERVA_NO_VALIDA/);
  });

  it('un miembro NO puede insertar ni modificar material saltándose la RPC', async () => {
    const s = await sesion();
    await expect(
      b.como(s.m, () => b.db.query(
        `INSERT INTO material_sesion (tenant_id, reserva_id, usuario_id, tipo, titulo, url_externa) VALUES ($1, $2, $3, 'enlace', 'x', 'https://x.com')`,
        [b.tenantId, s.reservaId, s.m.id]
      ))
    ).rejects.toThrow(/permission denied/);
  });
});

describe('quién ve y descarga qué', () => {
  it('cada miembro ve SOLO su material; otro miembro no ve nada', async () => {
    const s = await sesion();
    const otro = await b.crearPersona();
    await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/mio' });
    expect(await loQueVe(s.m)).toHaveLength(1);
    expect(await loQueVe(otro)).toHaveLength(0);
  });

  it('descarga (Storage): el dueño puede leer su objeto; otro miembro NO, ni con la ruta exacta', async () => {
    const s = await sesion();
    const otro = await b.crearPersona();
    const ruta = `${s.carpeta}/uuid-episodio.mp4`;
    await b.db.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('material', $1)", [ruta]);
    await registrar(recep, { reserva: s.reservaId, tipo: 'archivo', path: ruta });

    expect(await puedeLeerObjeto(s.m, ruta)).toBe(true);
    expect(await puedeLeerObjeto(otro, ruta)).toBe(false);
    expect(await puedeLeerObjeto(recep, ruta)).toBe(true);
  });

  it('VENCIDO: desaparece de "Mi material" y ya no se puede descargar, aunque conserve la ruta', async () => {
    const s = await sesion();
    const ruta = `${s.carpeta}/uuid-vencido.mp4`;
    await b.db.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('material', $1)", [ruta]);
    const mat = await registrar(recep, { reserva: s.reservaId, tipo: 'archivo', path: ruta, dias: 5 });
    await b.db.query("UPDATE material_sesion SET disponible_hasta = now() - interval '1 hour' WHERE id = $1", [mat.material_id]);

    expect(await loQueVe(s.m)).toHaveLength(0);
    expect(await puedeLeerObjeto(s.m, ruta)).toBe(false);
  });

  it('retirado por el staff: deja de verse y de poder descargarse; la RPC devuelve la ruta para borrar el objeto', async () => {
    const s = await sesion();
    const ruta = `${s.carpeta}/uuid-retirado.mp4`;
    await b.db.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('material', $1)", [ruta]);
    const mat = await registrar(recep, { reserva: s.reservaId, tipo: 'archivo', path: ruta });

    const r = await b.como(recep, () => b.fila<{ r: { storage_path: string } }>('SELECT staff_eliminar_material($1) AS r', [mat.material_id]));

    expect(r.r.storage_path).toBe(ruta);
    expect(await loQueVe(s.m)).toHaveLength(0);
    expect(await puedeLeerObjeto(s.m, ruta)).toBe(false);
  });

  it('un recepcionista REVOCADO no ve ni sube material', async () => {
    const s = await sesion();
    const revocado = await b.crearPersona({ rol: 'recepcionista', status: 'revocado' });
    await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/z' });
    expect(await loQueVe(revocado)).toHaveLength(0);
    await expect(registrar(revocado, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com' })).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });
});

describe('aviso "tu material está listo"', () => {
  const avisar = (actor: Persona, reservaId: string) =>
    b.como(actor, () => b.fila<{ r: Record<string, unknown> }>('SELECT staff_avisar_material($1) AS r', [reservaId])).then((x) => x.r);
  const avisos = (m: Persona) =>
    b.filas<{ mensaje: string; metadata: { url: string }; email_enviado_at: string | null }>(
      "SELECT mensaje, metadata, email_enviado_at FROM notificaciones WHERE usuario_id = $1 AND tipo = 'material_disponible'", [m.id]);

  it('UN aviso por tanda (no uno por archivo), con set, fecha, cuántos archivos y hasta cuándo — pendiente de correo', async () => {
    const s = await sesion();
    await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/1' });
    await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/2' });

    expect(await avisar(recep, s.reservaId)).toMatchObject({ success: true, archivos: 2 });

    const [aviso, ...resto] = await avisos(s.m);
    expect(resto).toHaveLength(0);
    expect(aviso.mensaje).toMatch(/^Ya puedes descargar el material de tu sesión en set-prueba-\d+ del .*, 17:00 \(2 archivos\)\. Disponible hasta el /);
    expect(aviso.metadata.url).toBe('/app/material');
    expect(aviso.email_enviado_at).toBeNull();
  });

  it('doble clic → no se manda dos veces', async () => {
    const s = await sesion();
    await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/1' });
    await avisar(recep, s.reservaId);
    expect(await avisar(recep, s.reservaId)).toMatchObject({ ya_avisado: true });
    expect(await avisos(s.m)).toHaveLength(1);
  });

  it('sin material no hay nada que avisar', async () => {
    const s = await sesion();
    await expect(avisar(recep, s.reservaId)).rejects.toThrow(/EKKO_SIN_MATERIAL/);
  });
});

describe('limpieza de archivos vencidos', () => {
  it('devuelve y marca los ARCHIVOS vencidos hace más de 7 días; no toca enlaces ni lo recién vencido', async () => {
    const s = await sesion();
    const viejo = await registrar(recep, { reserva: s.reservaId, tipo: 'archivo', path: `${s.carpeta}/viejo.mp4`, dias: 5 });
    const reciente = await registrar(recep, { reserva: s.reservaId, tipo: 'archivo', path: `${s.carpeta}/reciente.mp4`, dias: 5 });
    const enlace = await registrar(recep, { reserva: s.reservaId, tipo: 'enlace', url: 'https://ejemplo.com/e', dias: 5 });
    await b.db.query("UPDATE material_sesion SET disponible_hasta = now() - interval '8 days' WHERE id = ANY($1)", [[viejo.material_id, enlace.material_id]]);
    await b.db.query("UPDATE material_sesion SET disponible_hasta = now() - interval '1 day' WHERE id = $1", [reciente.material_id]);

    const borrar = await b.filas<{ material_id: string; storage_path: string }>('SELECT * FROM material_vencido_por_borrar(100)');

    expect(borrar).toEqual([{ material_id: viejo.material_id, storage_path: `${s.carpeta}/viejo.mp4` }]);
    // Idempotente: la segunda pasada ya no lo devuelve.
    expect(await b.filas('SELECT * FROM material_vencido_por_borrar(100)')).toHaveLength(0);
  });

  it('solo la puede ejecutar service_role', async () => {
    await expect(b.como(recep, () => b.filas('SELECT * FROM material_vencido_por_borrar(10)'))).rejects.toThrow(/permission denied/);
  });
});
