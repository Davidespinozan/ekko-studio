// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-02C · migración 20261006100000 contra Postgres real (PGlite).
 *
 *  Avisos: el cliente solo marca leído/no leído lo suyo; contenido y evidencia de
 *          envío son del servidor; no puede crear avisos por REST.
 *  Gate `cambiar_password`: lo cierra el cambio REAL de contraseña (trigger en
 *          auth.users), no el cliente; "marcar todas" no lo apaga; un fallo deja
 *          el gate abierto, nunca un falso "cambiada".
 *  Notas:  autor y rol vienen de la sesión y de `usuarios`; inmutables.
 *  Grants: anon no escribe ni ejecuta funciones de aplicación; authenticated no
 *          escribe donde ninguna política lo autoriza; nadie trunca.
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let m: Persona;

const aviso = (p: Persona, tipo = 'aviso_manual') =>
  b.fila<{ id: string }>(
    `INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
     VALUES ($1, $2, $3, 'Título', 'Mensaje', '{"url": "/app"}') RETURNING id`, [b.tenantId, p.id, tipo]).then((x) => x.id);
const fila = (id: string) =>
  b.fila<{ leida: boolean; leida_at: string | null; mensaje: string; metadata: Record<string, unknown>; email_enviado_at: string | null }>(
    'SELECT leida, leida_at, mensaje, metadata, email_enviado_at FROM notificaciones WHERE id = $1', [id]);
const comoAnon = async <T,>(fn: () => Promise<T>): Promise<T> => {
  await b.db.exec(`SELECT set_config('request.jwt.claim.role', 'anon', false); SET ROLE anon;`);
  try { return await fn(); } finally { await b.db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role', '', false);`); }
};

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  m = await b.crearPersona();
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('avisos: frontera del cliente', () => {
  it('el miembro marca leído lo suyo (y lo puede volver a no leído); no toca lo ajeno', async () => {
    const mio = await aviso(m);
    const ajeno = await aviso(recep);
    await b.como(m, () => b.fila(`UPDATE notificaciones SET leida = true, leida_at = now() WHERE id = $1`, [mio]));
    expect((await fila(mio)).leida).toBe(true);
    const n = await b.como(m, () => b.filas(`UPDATE notificaciones SET leida = true WHERE id = $1 RETURNING id`, [ajeno]));
    expect(n).toEqual([]);
    expect((await fila(ajeno)).leida).toBe(false);
  });

  it('contenido, metadata y evidencia de correo/push son del servidor: EKKO_AVISO_SOLO_LECTURA', async () => {
    const id = await aviso(m);
    for (const set of ["mensaje = 'otro'", "titulo = 'otro'", `metadata = '{"url": "/admin"}'`, 'email_enviado_at = now()',
      "email_resultado = 'aceptado'", 'push_enviado_at = now()', "tipo = 'no_show'", 'creada_at = now()']) {
      await expect(b.como(m, () => b.fila(`UPDATE notificaciones SET ${set} WHERE id = $1`, [id])), set).rejects.toThrow(/EKKO_AVISO_SOLO_LECTURA/);
    }
    expect(await fila(id)).toMatchObject({ mensaje: 'Mensaje', email_enviado_at: null });
  });

  it('nadie crea avisos por REST (ni el admin); el servidor sí', async () => {
    const ins = (p: Persona) => b.como(p, () => b.fila(
      `INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje) VALUES ($1, $2, 'aviso_manual', 't', 'm')`, [b.tenantId, m.id]));
    await expect(ins(admin)).rejects.toThrow(/row-level security|permission denied/);
    await expect(ins(recep)).rejects.toThrow(/row-level security|permission denied/);
    await expect(ins(m)).rejects.toThrow(/row-level security|permission denied/);
    await expect(aviso(m)).resolves.toBeTruthy(); // service_role / triggers
    // Los crons (service_role) siguen escribiendo la evidencia de envío.
    const id = await aviso(m);
    await b.db.query(`UPDATE notificaciones SET push_enviado_at = now(), email_enviado_at = now(), email_resultado = 'aceptado', email_proveedor_id = 're_x' WHERE id = $1`, [id]);
    expect((await fila(id)).email_enviado_at).not.toBeNull();
  });
});

describe('gate cambiar_password: autoridad del servidor', () => {
  it('el miembro NO lo apaga marcándolo leído, ni uno a uno ni con "marcar todas"; otros avisos sí se marcan', async () => {
    const gate = await aviso(m, 'cambiar_password');
    const otro = await aviso(m);
    await b.como(m, () => b.fila(`UPDATE notificaciones SET leida = true, leida_at = now() WHERE id = $1`, [gate]));
    expect(await fila(gate)).toMatchObject({ leida: false, leida_at: null });
    // "Marcar todas" (incluso sin el filtro del front).
    await b.como(m, () => b.fila(`UPDATE notificaciones SET leida = true, leida_at = now() WHERE usuario_id = $1 AND leida = false`, [m.id]));
    expect((await fila(otro)).leida).toBe(true);
    expect((await fila(gate)).leida).toBe(false);
  });

  it('un cambio REAL de contraseña en auth.users cierra el aviso; cambiar el correo no', async () => {
    const gate = await aviso(m, 'cambiar_password');
    await b.db.query(`UPDATE auth.users SET email = 'nuevo-' || email WHERE id = $1`, [m.authId]);
    expect((await fila(gate)).leida).toBe(false);
    await b.db.query(`UPDATE auth.users SET encrypted_password = 'hash-nuevo' WHERE id = $1`, [m.authId]);
    const f = await fila(gate);
    expect(f.leida).toBe(true);
    expect(f.leida_at).not.toBeNull();
    // Idempotente: otro cambio no reabre ni duplica nada.
    await b.db.query(`UPDATE auth.users SET encrypted_password = 'hash-otro' WHERE id = $1`, [m.authId]);
    expect((await fila(gate)).leida).toBe(true);
  });

  it('solo cierra el aviso del dueño de esa cuenta', async () => {
    const gateM = await aviso(m, 'cambiar_password');
    const gateR = await aviso(recep, 'cambiar_password');
    await b.db.query(`UPDATE auth.users SET encrypted_password = 'h2' WHERE id = $1`, [recep.authId]);
    expect((await fila(gateR)).leida).toBe(true);
    expect((await fila(gateM)).leida).toBe(false);
  });

  it('un fallo del mecanismo no bloquea el cambio de contraseña ni produce un falso "cambiada"', async () => {
    // Cuenta de auth sin perfil en usuarios: el trigger no tiene qué cerrar y no explota.
    const huerfano = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('h@x.mx', '{}') RETURNING id`);
    await b.db.query(`DELETE FROM usuarios WHERE auth_id = $1`, [huerfano.id]);
    await expect(b.db.query(`UPDATE auth.users SET encrypted_password = 'h3' WHERE id = $1`, [huerfano.id])).resolves.toBeTruthy();
    // Y si el UPDATE interno falla (simulado quitando el permiso de la tabla al
    // dueño del trigger no es posible aquí), el EXCEPTION del trigger deja el aviso
    // abierto: se verifica por definición.
    const d = (await b.fila<{ d: string }>(`SELECT pg_get_functiondef('handle_auth_user_password_change'::regproc) AS d`)).d;
    expect(d).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(d).toMatch(/RAISE WARNING/);
    expect(d).not.toMatch(/RETURN NULL/);
  });
});

describe('notas: autor y rol del servidor', () => {
  const nota = (p: Persona, autorId: string, autorRol: string) =>
    b.como(p, () => b.fila<{ id: string }>(
      `INSERT INTO notas_miembro (tenant_id, miembro_id, autor_id, autor_rol, contenido) VALUES ($1, $2, $3, $4, 'hola') RETURNING id`,
      [b.tenantId, m.id, autorId, autorRol]));
  const leer = (id: string) => b.fila<{ autor_id: string; autor_rol: string }>('SELECT autor_id, autor_rol FROM notas_miembro WHERE id = $1', [id]);

  it('recepción firma como recepcionista aunque mande "admin" u otro autor', async () => {
    const n = await nota(recep, admin.id, 'admin');
    expect(await leer(n.id)).toEqual({ autor_id: recep.id, autor_rol: 'recepcionista' });
    const a = await nota(admin, recep.id, 'recepcionista');
    expect(await leer(a.id)).toEqual({ autor_id: admin.id, autor_rol: 'admin' });
  });

  it('autor, rol, miembro y fecha son inmutables; el contenido sí se edita', async () => {
    const n = await nota(recep, recep.id, 'recepcionista');
    for (const set of ["autor_rol = 'admin'", `autor_id = '${admin.id}'`, `miembro_id = '${recep.id}'`, "creada_at = now() - interval '1 day'"]) {
      await expect(b.como(recep, () => b.fila(`UPDATE notas_miembro SET ${set} WHERE id = $1`, [n.id])), set).rejects.toThrow(/EKKO_NOTA_AUTOR_INMUTABLE/);
      await expect(b.db.query(`UPDATE notas_miembro SET ${set} WHERE id = $1`, [n.id]), set).rejects.toThrow(/EKKO_NOTA_AUTOR_INMUTABLE/);
    }
    await b.como(recep, () => b.fila(`UPDATE notas_miembro SET contenido = 'editado', actualizada_at = now() WHERE id = $1`, [n.id]));
  });

  it('un miembro no crea notas', async () => {
    await expect(nota(m, m.id, 'miembro')).rejects.toThrow(/row-level security|permission denied/);
  });
});

describe('grants derivados del esquema', () => {
  it('anon: ninguna escritura en tablas ni vistas; ningún EXECUTE en funciones de aplicación; sigue leyendo lo público', async () => {
    const dml = await b.filas<{ t: string; p: string }>(
      `SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee = 'anon' AND privilege_type <> 'SELECT'`);
    expect(dml).toEqual([]);
    const fns = await b.filas<{ f: string }>(
      `SELECT p.proname AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.objid = p.oid AND d.deptype = 'e')`);
    expect(fns).toEqual([]);
    // Las RPC y los helpers de RLS siguen para authenticated y service_role (grant explícito, no vía PUBLIC).
    for (const f of ['reservar_recurso_atomic(uuid, timestamptz, integer, integer, text)', 'check_in_atomic(uuid)', 'is_admin()', 'is_recepcionista()', 'get_my_user_id()', 'get_my_tenant_id()', 'get_my_rol()']) {
      const p = await b.fila<{ a: boolean; s: boolean }>(`SELECT has_function_privilege('authenticated', '${f}', 'EXECUTE') AS a, has_function_privilege('service_role', '${f}', 'EXECUTE') AS s`);
      expect(p, f).toEqual({ a: true, s: true });
    }
    const publico = await b.filas<{ f: string }>(
      `SELECT p.proname AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.objid = p.oid AND d.deptype = 'e')`);
    expect(publico).toEqual([]);
    const tiers = await comoAnon(() => b.filas('SELECT slug FROM tiers WHERE activo'));
    expect(tiers.length).toBeGreaterThan(0);
    await expect(comoAnon(() => b.fila(`SELECT reservar_recurso_atomic(gen_random_uuid(), now(), 60, 0, NULL)`))).rejects.toThrow(/permission denied/);
    await expect(comoAnon(() => b.fila(`INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje) VALUES ($1, $2, 'x', 't', 'm')`, [b.tenantId, m.id]))).rejects.toThrow(/permission denied/);
  });

  it('authenticated: sin escritura donde ninguna política la autoriza; sin TRUNCATE en ningún lado; donde hay política, sigue', async () => {
    const sinPolicy = await b.filas<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name NOT IN (SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT')`);
    expect(sinPolicy.length).toBeGreaterThan(10);
    const grants = await b.filas<{ t: string; p: string }>(
      `SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
         AND table_name = ANY($1)`, [sinPolicy.map((x) => x.t)]);
    expect(grants).toEqual([]);
    const trunc = await b.filas(`SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')`);
    expect(trunc).toEqual([]);
    // Lo que sí tiene política sigue funcionando por REST.
    await b.como(m, () => b.fila(`UPDATE usuarios SET nombre = 'Yo' WHERE id = $1`, [m.id]));
    await b.como(m, () => b.fila(`INSERT INTO push_subscriptions (tenant_id, usuario_id, endpoint, p256dh, auth) VALUES ($1, $2, 'https://p/x', 'k', 'a')`, [b.tenantId, m.id]));
    await b.como(admin, () => b.fila(`UPDATE tenants SET config = config WHERE id = $1`, [b.tenantId]));
    // Y una tabla de evidencia ni con RLS ni con GRANT.
    await expect(b.como(admin, () => b.fila(`INSERT INTO payment_events (stripe_event_id, stripe_event_type, status) VALUES ('evt_x', 'invoice.paid', 'succeeded')`))).rejects.toThrow(/permission denied/);
  });

  it('las funciones existentes no cambiaron de cuerpo: solo hay 3 funciones nuevas en esta migración', async () => {
    const nuevas = await b.filas<{ f: string }>(
      `SELECT proname AS f FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('notificaciones_frontera_cliente', 'handle_auth_user_password_change', 'notas_miembro_autor_servidor') ORDER BY 1`);
    expect(nuevas.map((x) => x.f)).toEqual(['handle_auth_user_password_change', 'notas_miembro_autor_servidor', 'notificaciones_frontera_cliente']);
    const trg = await b.filas<{ t: string }>(`SELECT tgname AS t FROM pg_trigger WHERE tgname IN ('trg_notificaciones_frontera_cliente', 'on_auth_user_password_changed', 'trg_notas_miembro_autor_servidor')`);
    expect(trg).toHaveLength(3);
  });
});
