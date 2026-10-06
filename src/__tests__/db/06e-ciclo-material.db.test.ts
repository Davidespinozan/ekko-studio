// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-06E · migración 20261018100000 contra Postgres real (PGlite).
 *
 * Storage se simula con sus metadatos (`storage.objects`), que es lo que la base
 * compara: un INSERT = objeto subido, un DELETE = objeto borrado por la API.
 *  · limpieza pendiente = fila retirada/vencida cuyo objeto sigue ahí (derivada);
 *  · retirar es idempotente; pendiente de material = sesión con check-in que nunca
 *    recibió material;
 *  · Operación (solo admin, su estudio): material sin archivo, limpieza atascada y
 *    objetos huérfanos (agregados, nunca borrados).
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let adminB: Persona;
let tenantB: string;
let dia = 2;

type J = Record<string, unknown>;
type Pend = { dominio: string; tipo: string; fuente: string; fuente_id: string; usuario_id: string | null; severidad: string; accion: string; detalle: string | null };

async function sesion(status: 'completada' | 'confirmada' | null = null) {
  const m = await b.crearPersona();
  await b.activar(m, 'pro-pack');
  const r = await b.reservar(m, await b.crearEstudio(), await b.slot(++dia, 17));
  if (status) {
    await b.db.query(
      `UPDATE reservas SET slot_inicio = now() - interval '3 hours', slot_fin = now() - interval '2 hours', status = $2 WHERE id = $1`,
      [r.reserva_id, status]
    );
  }
  return { m, reservaId: r.reserva_id as string, carpeta: `${b.tenantId}/${m.id}/${r.reserva_id}` };
}
const subirObjeto = (ruta: string, antiguedad = '0 seconds', bytes = 2_097_152) =>
  b.db.query(
    `INSERT INTO storage.objects (bucket_id, name, created_at, metadata) VALUES ('material', $1, now() - $2::interval, $3::jsonb)`,
    [ruta, antiguedad, JSON.stringify({ size: bytes })]
  );
/** Lo que hace la API de Storage al borrar (con service_role o el staff). */
const borrarObjeto = (ruta: string) => b.db.query(`DELETE FROM storage.objects WHERE bucket_id = 'material' AND name = $1`, [ruta]);
const registrar = (actor: Persona, reserva: string, extra: { path?: string; url?: string; titulo?: string; dias?: number | null } = {}) =>
  b.como(actor, () =>
    b.fila<{ r: { material_id: string } }>(
      `SELECT staff_registrar_material($1, $2, $3, $4, $5, NULL, NULL, NULL, $6) AS r`,
      [reserva, extra.url ? 'enlace' : 'archivo', extra.titulo ?? 'Episodio', extra.path ?? null, extra.url ?? null, extra.dias ?? null]
    ).then((x) => x.r.material_id)
  );
const retirar = (actor: Persona, id: string) =>
  b.como(actor, () => b.fila<{ r: J }>('SELECT staff_eliminar_material($1) AS r', [id]).then((x) => x.r));
const limpiezaPendiente = () =>
  b.filas<{ material_id: string; storage_path: string }>('SELECT * FROM material_limpieza_pendiente(500)');
const pendientesMaterial = (p: Persona) =>
  b.como(p, () => b.filas<Pend>(`SELECT * FROM v_pendientes_operativos WHERE dominio = 'material' ORDER BY tipo, fuente_id`));
const materialPendiente = (p: Persona) =>
  b.como(p, () => b.filas<{ reserva_id: string }>('SELECT reserva_id FROM staff_listar_material_pendiente()'));
const envejecerRetiro = (id: string, intervalo: string) =>
  b.db.query(`UPDATE material_sesion SET eliminado_at = now() - $2::interval WHERE id = $1`, [id, intervalo]);

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  tenantB = (await b.fila<{ id: string }>(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-06e', 'Otro', 'activo') RETURNING id`)).id;
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-b-06e@test.mx', '{"tenant_slug":"b-06e"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = $1 RETURNING id`, [a.id]);
  adminB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('limpieza pendiente (derivada de la fila + Storage) · FR-43/44', () => {
  it('17/19 · retirado con su objeto presente = pendiente; borrado el objeto = converge; un vivo o un enlace nunca', async () => {
    const s = await sesion();
    const ruta = `${s.carpeta}/a-retirado.mp4`;
    await subirObjeto(ruta);
    const id = await registrar(recep, s.reservaId, { path: ruta });
    const vivo = `${s.carpeta}/b-vivo.mp4`;
    await subirObjeto(vivo);
    await registrar(recep, s.reservaId, { path: vivo });
    const enlace = await registrar(recep, s.reservaId, { url: 'https://ejemplo.com/x' });
    await retirar(recep, enlace);

    expect(await limpiezaPendiente()).not.toContainEqual(expect.objectContaining({ storage_path: vivo }));
    await retirar(recep, id);
    expect(await limpiezaPendiente()).toContainEqual({ material_id: id, storage_path: ruta });
    // Reintento repetido (sin borrar): sigue siendo UNA obligación, no se duplica.
    expect((await limpiezaPendiente()).filter((f) => f.material_id === id)).toHaveLength(1);
    await borrarObjeto(ruta);
    expect(await limpiezaPendiente()).not.toContainEqual(expect.objectContaining({ material_id: id }));
  });

  it('11 · objeto que YA no estaba cuando se retiró → nunca es pendiente (converge sin error)', async () => {
    const s = await sesion();
    const id = await registrar(recep, s.reservaId, { path: `${s.carpeta}/nunca-subido.mp4` });
    await retirar(recep, id);
    expect(await limpiezaPendiente()).not.toContainEqual(expect.objectContaining({ material_id: id }));
  });

  it('13/15/16 · vencido: el barrido lo marca (acceso ya terminado) y queda pendiente hasta que el objeto se borre', async () => {
    const s = await sesion();
    const ruta = `${s.carpeta}/vencido.mp4`;
    await subirObjeto(ruta);
    const id = await registrar(recep, s.reservaId, { path: ruta, dias: 5 });
    await b.db.query(`UPDATE material_sesion SET disponible_hasta = now() - interval '8 days' WHERE id = $1`, [id]);
    expect(await b.como(s.m, () => b.filas('SELECT id FROM material_sesion'))).toEqual([]); // 14 · el miembro ya no lo ve
    await b.filas('SELECT * FROM material_vencido_por_borrar(100)');
    expect(await limpiezaPendiente()).toContainEqual({ material_id: id, storage_path: ruta });
  });

  it('el límite acota la tanda (1..500) y el orden es el de retiro (lo más viejo primero)', async () => {
    const s = await sesion();
    const ids: string[] = [];
    for (const n of ['x1', 'x2', 'x3']) {
      const ruta = `${s.carpeta}/${n}.mp4`;
      await subirObjeto(ruta);
      const id = await registrar(recep, s.reservaId, { path: ruta });
      await retirar(recep, id);
      ids.push(id);
    }
    await envejecerRetiro(ids[2], '10 days');
    const uno = await b.filas<{ material_id: string }>('SELECT * FROM material_limpieza_pendiente(1)');
    expect(uno).toHaveLength(1);
    expect((await b.filas('SELECT * FROM material_limpieza_pendiente(0)'))).toHaveLength(1);
    expect((await b.filas<{ material_id: string }>('SELECT * FROM material_limpieza_pendiente(500)'))[0].material_id).toBe(ids[2]);
    // Converge (la base compartida no arrastra estos objetos a los casos siguientes).
    for (const n of ['x1', 'x2', 'x3']) await borrarObjeto(`${s.carpeta}/${n}.mp4`);
  });

  it('41/42/45 · solo service_role la ejecuta; search_path fijo; definer', async () => {
    await expect(b.como(admin, () => b.filas('SELECT * FROM material_limpieza_pendiente(10)'))).rejects.toThrow(/permission denied/);
    const r = await b.fila<J>(`SELECT has_function_privilege('anon', 'material_limpieza_pendiente(integer)', 'EXECUTE') AS anon_x,
      has_function_privilege('authenticated', 'material_limpieza_pendiente(integer)', 'EXECUTE') AS auth_x,
      has_function_privilege('service_role', 'material_limpieza_pendiente(integer)', 'EXECUTE') AS svc_x,
      (SELECT proconfig FROM pg_proc WHERE proname = 'material_limpieza_pendiente') AS cfg,
      (SELECT prosecdef FROM pg_proc WHERE proname = 'material_limpieza_pendiente') AS definer`);
    expect(r).toEqual({ anon_x: false, auth_x: false, svc_x: true, cfg: ['search_path=public'], definer: true });
  });
});

describe('retirar material · idempotente (FR-43)', () => {
  it('6/7/10 · retirar quita el acceso al instante; retirar otra vez converge con la misma ruta y SIN otra auditoría', async () => {
    const s = await sesion();
    const ruta = `${s.carpeta}/dos-veces.mp4`;
    await subirObjeto(ruta);
    const id = await registrar(recep, s.reservaId, { path: ruta });
    expect(await retirar(recep, id)).toMatchObject({ success: true, ya_retirado: false, storage_path: ruta });
    expect(await b.como(s.m, () => b.filas('SELECT id FROM material_sesion'))).toEqual([]);
    expect(await b.como(s.m, () => b.filas(`SELECT 1 FROM storage.objects WHERE name = $1`, [ruta]))).toEqual([]);
    expect(await retirar(admin, id)).toMatchObject({ success: true, ya_retirado: true, storage_path: ruta });
    const audits = await b.filas(`SELECT id FROM audit_log WHERE accion = 'material_retirado' AND metadata->>'material_id' = $1`, [id]);
    expect(audits).toHaveLength(1);
  });

  it('40/42 · otro estudio o un miembro no pueden retirar (ni aunque esté ya retirado)', async () => {
    const s = await sesion();
    const id = await registrar(recep, s.reservaId, { path: `${s.carpeta}/ajeno.mp4` });
    await expect(retirar(adminB, id)).rejects.toThrow(/EKKO_MATERIAL_NO_EXISTE/);
    await expect(retirar(s.m, id)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await retirar(recep, id);
    await expect(retirar(adminB, id)).rejects.toThrow(/EKKO_MATERIAL_NO_EXISTE/);
  });
});

describe('material pendiente · FR-46', () => {
  it('29/34 · sesión con check-in, que requiere material y nunca recibió nada → SÍ aparece', async () => {
    const s = await sesion('completada');
    expect(await materialPendiente(recep)).toContainEqual({ reserva_id: s.reservaId });
  });

  it('31 · material ENTREGADO que después venció y barrió la limpieza → NO vuelve a ser pendiente', async () => {
    const s = await sesion('completada');
    const id = await registrar(recep, s.reservaId, { path: `${s.carpeta}/entregado.mp4`, dias: 5 });
    await b.db.query(`UPDATE material_sesion SET disponible_hasta = now() - interval '8 days' WHERE id = $1`, [id]);
    await b.filas('SELECT * FROM material_vencido_por_borrar(100)');
    expect(await materialPendiente(recep)).not.toContainEqual({ reserva_id: s.reservaId });
  });

  it('32 · material retirado por el staff → NO es pendiente', async () => {
    const s = await sesion('completada');
    const id = await registrar(recep, s.reservaId, { url: 'https://ejemplo.com/retirado' });
    await retirar(recep, id);
    expect(await materialPendiente(recep)).not.toContainEqual({ reserva_id: s.reservaId });
  });

  it('33 · sesión pasada SIN check-in (confirmada) → no consta como ocurrida: NO es pendiente', async () => {
    const s = await sesion('confirmada');
    expect(await materialPendiente(recep)).not.toContainEqual({ reserva_id: s.reservaId });
  });

  it('30 · con material vivo → NO aparece', async () => {
    const s = await sesion('completada');
    await registrar(recep, s.reservaId, { url: 'https://ejemplo.com/vivo' });
    expect(await materialPendiente(recep)).not.toContainEqual({ reserva_id: s.reservaId });
  });
});

describe('Operación · reconciliación fila ↔ Storage (FR-45)', () => {
  it('20/21/36 · material vivo SIN objeto → un pendiente por material (con su miembro); con objeto, nada', async () => {
    const s = await sesion();
    const sin = await registrar(recep, s.reservaId, { path: `${s.carpeta}/perdido.mp4`, titulo: 'Episodio perdido' });
    const conRuta = `${s.carpeta}/presente.mp4`;
    await subirObjeto(conRuta);
    const con = await registrar(recep, s.reservaId, { path: conRuta });
    const lista = await pendientesMaterial(admin);
    expect(lista).toContainEqual(expect.objectContaining({
      tipo: 'material_sin_archivo', fuente_id: sin, usuario_id: s.m.id, severidad: 'media', accion: 'revisar_material_sin_archivo', detalle: 'Episodio perdido'
    }));
    expect(lista.find((p) => p.fuente_id === con)).toBeUndefined();
    // 38 · retirarlo (o volver a subirlo) lo resuelve: desaparece solo.
    await retirar(recep, sin);
    expect((await pendientesMaterial(admin)).find((p) => p.fuente_id === sin)).toBeUndefined();
  });

  it('22/35/38 · retirado hace > 2 días y el objeto sigue → UN renglón agregado; lo reciente no; borrado converge', async () => {
    const s = await sesion();
    const rutas = [`${s.carpeta}/atorado-1.mp4`, `${s.carpeta}/atorado-2.mp4`, `${s.carpeta}/reciente.mp4`];
    const ids: string[] = [];
    for (const r of rutas) {
      await subirObjeto(r);
      const id = await registrar(recep, s.reservaId, { path: r });
      await retirar(recep, id);
      ids.push(id);
    }
    await envejecerRetiro(ids[0], '3 days');
    await envejecerRetiro(ids[1], '5 days');
    const atascada = (await pendientesMaterial(admin)).filter((p) => p.tipo === 'material_limpieza_atascada');
    expect(atascada).toHaveLength(1); // 39 · sin duplicados
    expect(atascada[0]).toMatchObject({ accion: 'revisar_limpieza_material', severidad: 'baja', detalle: '2 archivos retirados siguen en el almacenamiento' });
    await borrarObjeto(rutas[0]);
    await borrarObjeto(rutas[1]);
    expect((await pendientesMaterial(admin)).filter((p) => p.tipo === 'material_limpieza_atascada')).toHaveLength(0);
  });

  it('23/24/37 · objeto sin fila (> 1 h) → huérfano agregado, SIN ruta en el texto; uno en curso (< 1 h) no; nada se borra', async () => {
    const huerfano = `${b.tenantId}/${admin.id}/00000000-0000-0000-0000-000000000000/sin-registro.mp4`;
    const enCurso = `${b.tenantId}/${admin.id}/00000000-0000-0000-0000-000000000000/subiendo.mp4`;
    await subirObjeto(huerfano, '2 hours', 3_145_728);
    await subirObjeto(enCurso, '5 minutes');
    const lista = (await pendientesMaterial(admin)).filter((p) => p.tipo === 'material_objeto_huerfano');
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ fuente: 'storage.objects', accion: 'revisar_objeto_huerfano', severidad: 'baja', detalle: '1 archivo sin material registrado · 3 MB' });
    expect(JSON.stringify(lista)).not.toContain('sin-registro');
    // La limpieza del servidor JAMÁS lo propone para borrar (no hay fila que lo nombre).
    expect(await limpiezaPendiente()).not.toContainEqual(expect.objectContaining({ storage_path: huerfano }));
    expect(await b.filas(`SELECT 1 FROM storage.objects WHERE name = $1`, [huerfano])).toHaveLength(1);
    // 28 · leer otra vez no duplica ni cambia nada.
    expect((await pendientesMaterial(admin)).filter((p) => p.tipo === 'material_objeto_huerfano')).toEqual(lista);
  });

  it('40 · aislamiento: el admin de otro estudio no ve los huérfanos, los faltantes ni la limpieza de este; ni recepción ni el miembro ven nada', async () => {
    await subirObjeto(`${tenantB}/x/y/de-b.mp4`, '3 hours');
    const deB = await pendientesMaterial(adminB);
    expect(deB.filter((p) => p.tipo === 'material_objeto_huerfano')).toEqual([
      expect.objectContaining({ fuente_id: `huerfanos:${tenantB}`, detalle: '1 archivo sin material registrado · 2 MB' })
    ]);
    expect(deB.filter((p) => p.tipo === 'material_sin_archivo')).toEqual([]);
    expect((await pendientesMaterial(admin)).every((p) => !p.fuente_id.includes(tenantB))).toBe(true);
    expect(await pendientesMaterial(recep)).toEqual([]);
    const s = await sesion();
    expect(await pendientesMaterial(s.m)).toEqual([]);
  });

  it('las ramas previas de la vista siguen ahí (06G/06B) y la vista sigue security_invoker', async () => {
    const r = await b.fila<{ opts: string[] | null; def: string }>(`SELECT (SELECT reloptions FROM pg_class WHERE oid = 'v_pendientes_operativos'::regclass) AS opts, pg_get_viewdef('v_pendientes_operativos'::regclass) AS def`);
    expect(r.opts).toContain('security_invoker=true');
    for (const s of ['revisiones_financieras', 'stripe_webhook_events', 'stripe_operaciones_suscripcion', 'correos_directos', 'v_reconciliacion_membresia', 'discrepancias_stripe', 'procesos_programados', 'resumen_fallos_push', 'material_sin_archivo', 'material_objeto_huerfano']) {
      expect(r.def).toContain(s);
    }
  });
});
