// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';
import { COLUMNAS_RESERVA_CLIENTE, COLUMNAS_USUARIO_CLIENTE } from '../../shared/lib/columnas';

/**
 * PKG-06D · migraciones 20261014100000 (A) y 20261014110000 (B) contra Postgres
 * real (PGlite).
 *
 * RLS ≠ privacidad de columnas: el miembro sigue leyendo SU fila y SUS reservas,
 * pero `authenticated` ya no tiene SELECT sobre notas_admin, sancion_motivo, los
 * marcadores de 06A, reservas.observaciones ni qr_token_hash. Lo interno lo lee
 * el staff por RPC con guardia. La búsqueda del panel recibe el texto como
 * parámetro ligado: la gramática de PostgREST ya no se construye con texto ajeno.
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let miembro: Persona;
let otro: Persona;
let adminB: Persona;
let reservaId: string;

const como = <T>(p: Persona, sql: string, params: unknown[] = []) => b.como(p, () => b.filas<T>(sql, params));
const comoAnon = async <T>(sql: string, params: unknown[] = []) => {
  await b.db.exec(`SELECT set_config('request.jwt.claim.role', 'anon', false); SET ROLE anon;`);
  try {
    return await b.filas<T>(sql, params);
  } finally {
    await b.db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false);`);
  }
};
const buscar = (p: Persona, texto: string | null, rol: string | null = null, status: string | null = null) =>
  como<{ id: string; nombre: string | null; email: string }>(p, 'SELECT id, nombre, email FROM buscar_cuentas_staff($1, $2, $3)', [texto, rol, status]);

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  miembro = await b.crearPersona();
  otro = await b.crearPersona();
  await b.db.query(`UPDATE usuarios SET notas_admin = 'Prefiere el set 2', sancion_motivo = 'Motivo interno', nombre = $2 WHERE id = $1`, [miembro.id, "Ana O'Brien, (Culiacán) 100%"]);
  await b.db.query(`UPDATE usuarios SET nombre = 'Luis Pérez', telefono = '6671234567' WHERE id = $1`, [otro.id]);
  await b.activar(miembro, 'esencial');
  const recurso = await b.crearEstudio();
  const slot = await b.slot(2, 11);
  const r = await b.como(recep, () => b.fila<{ r: { reserva_id: string } }>('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, 0, NULL) AS r', [miembro.id, recurso, slot]));
  reservaId = r.r.reserva_id;
  await b.db.query(`UPDATE reservas SET observaciones = 'Trajo equipo propio', qr_token_hash = 'hash-secreto' WHERE id = $1`, [reservaId]);
  await b.db.query(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-06d', 'Otro', 'activo')`);
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-b-06d@test.mx', '{"tenant_slug":"b-06d"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = $1 RETURNING id`, [a.id]);
  adminB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('usuarios: el miembro lee su fila, no las columnas internas', () => {
  it('1/12 · las columnas del cliente (las que usa la app) se leen; la lista es exactamente la permitida', async () => {
    const [fila] = await como<Record<string, unknown>>(miembro, `SELECT ${COLUMNAS_USUARIO_CLIENTE} FROM usuarios WHERE id = $1`, [miembro.id]);
    expect(fila).toMatchObject({ id: miembro.id, rol: 'miembro', status: 'activo' });
    expect(Object.keys(fila)).toHaveLength(22);
    const permitidas = await b.filas<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='usuarios' AND grantee='authenticated' AND privilege_type='SELECT' ORDER BY 1`);
    expect(permitidas.map((c) => c.column_name).sort()).toEqual(COLUMNAS_USUARIO_CLIENTE.split(',').map((c) => c.trim()).sort());
  });

  it('2/3/5 · notas_admin, sancion_motivo y los marcadores de 06A: permission denied, también con *', async () => {
    for (const col of ['notas_admin', 'sancion_motivo', 'acceso_autorizado_at', 'acceso_autorizado_por']) {
      await expect(como(miembro, `SELECT ${col} FROM usuarios WHERE id = $1`, [miembro.id])).rejects.toThrow(/permission denied/);
    }
    await expect(como(miembro, 'SELECT * FROM usuarios WHERE id = $1', [miembro.id])).rejects.toThrow(/permission denied/);
  });

  it('6 · la fila de otro usuario no se ve (RLS intacta)', async () => {
    expect(await como(miembro, 'SELECT id FROM usuarios WHERE id = $1', [otro.id])).toHaveLength(0);
  });

  it('12 · el miembro sigue editando nombre y teléfono (UPDATE y los triggers no dependen del SELECT revocado)', async () => {
    await b.como(miembro, () => b.db.query(`UPDATE usuarios SET nombre = 'Ana Nueva', telefono = '1' WHERE id = $1`, [miembro.id]));
    expect((await b.fila<{ nombre: string }>('SELECT nombre FROM usuarios WHERE id = $1', [miembro.id])).nombre).toBe('Ana Nueva');
    // Lo privilegiado sigue bloqueado por el trigger (02C/R1), no por el grant.
    await expect(b.como(miembro, () => b.db.query(`UPDATE usuarios SET status = 'activo', rol = 'admin' WHERE id = $1`, [miembro.id]))).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });

  it('7/8 · recepción y admin leen las mismas columnas por REST (el rol de base es el mismo) y lo interno por RPC', async () => {
    const [r] = await como<Record<string, unknown>>(recep, `SELECT ${COLUMNAS_USUARIO_CLIENTE} FROM usuarios WHERE id = $1`, [miembro.id]);
    expect(r.id).toBe(miembro.id);
    await expect(como(admin, 'SELECT notas_admin FROM usuarios WHERE id = $1', [miembro.id])).rejects.toThrow(/permission denied/);
    const [d] = await como<{ d: Record<string, unknown> }>(admin, 'SELECT staff_datos_internos_cuenta($1) AS d', [miembro.id]);
    expect(d.d).toMatchObject({ usuario_id: miembro.id, notas_admin: 'Prefiere el set 2', sancion_motivo: 'Motivo interno' });
    const [d2] = await como<{ d: Record<string, unknown> }>(recep, 'SELECT staff_datos_internos_cuenta($1) AS d', [miembro.id]);
    expect(d2.d).toMatchObject({ notas_admin: 'Prefiere el set 2' });
    // El admin sigue escribiendo la nota por REST (política update_admin + UPDATE por columna).
    await b.como(admin, () => b.db.query(`UPDATE usuarios SET notas_admin = 'Nota nueva' WHERE id = $1`, [miembro.id]));
    expect((await como<{ d: { notas_admin: string } }>(admin, 'SELECT staff_datos_internos_cuenta($1) AS d', [miembro.id]))[0].d.notas_admin).toBe('Nota nueva');
  });

  it('la RPC de datos internos: ni el miembro (ni sobre sí mismo), ni otro tenant', async () => {
    await expect(como(miembro, 'SELECT staff_datos_internos_cuenta($1)', [miembro.id])).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(como(adminB, 'SELECT staff_datos_internos_cuenta($1)', [miembro.id])).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
  });

  it('9/10 · service_role (aquí, superusuario) sigue leyendo todo; anon no gana nada (0 filas y sin columnas internas)', async () => {
    expect((await b.fila<{ notas_admin: string }>('SELECT notas_admin FROM usuarios WHERE id = $1', [miembro.id])).notas_admin).toBe('Nota nueva');
    expect(await comoAnon('SELECT id FROM usuarios')).toHaveLength(0);
    await expect(comoAnon('SELECT notas_admin FROM usuarios')).rejects.toThrow(/permission denied/);
    await expect(comoAnon('SELECT observaciones FROM reservas')).rejects.toThrow(/permission denied/);
    // Ninguna vista de public expone las columnas revocadas por otra vía.
    const views = await b.filas<{ viewname: string; definition: string }>(`SELECT viewname, definition FROM pg_views WHERE schemaname='public'`);
    for (const v of views) expect(v.definition, v.viewname).not.toMatch(/notas_admin|sancion_motivo|observaciones|qr_token_hash|acceso_autorizado/);
  });

  it('las vistas de staff (security_invoker) siguen funcionando con las columnas permitidas (v_libro_economico es solo de service_role, como antes)', async () => {
    await como(admin, 'SELECT * FROM v_pendientes_operativos');
    await como(admin, 'SELECT * FROM v_reconciliacion_membresia');
    expect((await b.fila<{ ok: boolean }>(`SELECT has_table_privilege('authenticated', 'public.v_libro_economico', 'SELECT') AS ok`)).ok).toBe(false);
  });
});

describe('reservas: observaciones y qr_token_hash son del servidor', () => {
  it('el miembro lee sus reservas con las columnas del cliente; observaciones y qr_token_hash: denied', async () => {
    const [r] = await como<Record<string, unknown>>(miembro, `SELECT ${COLUMNAS_RESERVA_CLIENTE} FROM reservas WHERE id = $1`, [reservaId]);
    expect(r.id).toBe(reservaId);
    expect(Object.keys(r)).toHaveLength(26);
    await expect(como(miembro, 'SELECT observaciones FROM reservas WHERE id = $1', [reservaId])).rejects.toThrow(/permission denied/);
    await expect(como(miembro, 'SELECT qr_token_hash FROM reservas WHERE id = $1', [reservaId])).rejects.toThrow(/permission denied/);
    await expect(como(miembro, 'SELECT * FROM reservas WHERE id = $1', [reservaId])).rejects.toThrow(/permission denied/);
    const permitidas = await b.filas<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='reservas' AND grantee='authenticated' AND privilege_type='SELECT' ORDER BY 1`);
    expect(permitidas.map((c) => c.column_name).sort()).toEqual(COLUMNAS_RESERVA_CLIENTE.split(',').map((c) => c.trim()).sort());
  });

  it('el staff lee las observaciones por RPC; el miembro y otro tenant no', async () => {
    expect((await como<{ o: string }>(recep, 'SELECT staff_observaciones_reserva($1) AS o', [reservaId]))[0].o).toBe('Trajo equipo propio');
    await expect(como(miembro, 'SELECT staff_observaciones_reserva($1)', [reservaId])).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(como(adminB, 'SELECT staff_observaciones_reserva($1)', [reservaId])).rejects.toThrow(/EKKO_RESERVA_NO_EXISTE/);
  });

  it('el QR y el check-in (RPC SECURITY DEFINER) no dependen del grant', async () => {
    const r = await como<{ s: string }>(recep, `SELECT status AS s FROM reservas WHERE id = $1`, [reservaId]);
    expect(r[0].s).toBe('confirmada');
  });
});

describe('buscar_cuentas_staff: el texto es un parámetro, nunca gramática', () => {
  it('27/28/29 · nombre, correo, teléfono, acentos y espacios', async () => {
    expect((await buscar(admin, 'ana nue')).map((x) => x.id)).toEqual([miembro.id]);
    expect((await buscar(recep, (await b.fila<{ email: string }>('SELECT email FROM usuarios WHERE id = $1', [otro.id])).email.toUpperCase())).map((x) => x.id)).toEqual([otro.id]);
    expect((await buscar(admin, '667123')).map((x) => x.id)).toEqual([otro.id]);
    expect((await buscar(admin, 'pérez')).map((x) => x.id)).toEqual([otro.id]);
  });

  it('30/31/32/33 · apóstrofe, coma, paréntesis, porcentaje y guion bajo son TEXTO literal', async () => {
    await b.db.query(`UPDATE usuarios SET nombre = $2 WHERE id = $1`, [miembro.id, "Ana O'Brien, (Culiacán) 100%_x"]);
    expect((await buscar(admin, "O'Brien")).map((x) => x.id)).toEqual([miembro.id]);
    expect((await buscar(admin, 'Brien, (Culi')).map((x) => x.id)).toEqual([miembro.id]);
    expect((await buscar(admin, '100%_x')).map((x) => x.id)).toEqual([miembro.id]);
    // `%` y `_` no son comodines: '1%x' no casa con '100%_x' por comodín.
    expect(await buscar(admin, '1%x')).toHaveLength(0);
    expect(await buscar(admin, 'An_ O')).toHaveLength(0);
  });

  it('34 · una carga con gramática de PostgREST se busca como texto y no altera la consulta', async () => {
    const carga = `x),email.ilike.%@%,nombre.ilike.%`;
    expect(await buscar(admin, carga)).toHaveLength(0);
    expect(await buscar(admin, `' OR 1=1 --`)).toHaveLength(0);
    expect(await buscar(admin, `*`)).toHaveLength(0);
  });

  it('filtros de rol/status, "staff" agrupa recepción/admin, solo el tenant del actor, y nunca columnas internas', async () => {
    const staff = await buscar(admin, null, 'staff');
    expect(staff.map((x) => x.id).sort()).toEqual([admin.id, recep.id].sort());
    expect((await buscar(admin, null, 'miembro', 'activo')).map((x) => x.id)).toEqual(expect.arrayContaining([miembro.id, otro.id]));
    expect((await buscar(adminB, null)).map((x) => x.id)).toEqual([adminB.id]);
    const cols = await b.filas<{ attname: string }>(`SELECT a.attname FROM pg_proc p JOIN pg_type t ON t.oid = p.prorettype, unnest(p.proargnames) WITH ORDINALITY AS a(attname, n) WHERE p.proname = 'buscar_cuentas_staff' AND n > 3`);
    expect(cols.map((c) => c.attname)).not.toContain('notas_admin');
    expect(cols.map((c) => c.attname)).not.toContain('sancion_motivo');
    await expect(buscar(miembro, 'x')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
  });
});

describe('frontera: anon no ejecuta las RPC nuevas', () => {
  it('anon sin EXECUTE; authenticated sí (la guardia es interna)', async () => {
    for (const f of ['staff_datos_internos_cuenta(uuid)', 'staff_observaciones_reserva(uuid)', 'buscar_cuentas_staff(text, text, text)']) {
      const p = await b.fila<{ an: boolean; au: boolean }>(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS an, has_function_privilege('authenticated', $1, 'EXECUTE') AS au`, [f]);
      expect([f, p.an, p.au]).toEqual([f, false, true]);
    }
  });
});
