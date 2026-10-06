// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-06C · migración 20261017100000 contra Postgres real (PGlite).
 *
 * El proveedor de Auth se simula como en producción:
 *  · alta pública: INSERT en auth.users con email_confirmed_at = NULL (createUser
 *    con email_confirm=false) y, cuando el dueño del buzón abre el enlace, UPDATE de
 *    email_confirmed_at (lo que hace el verify del proveedor);
 *  · alta del staff: INSERT ya confirmado (default del stub), igual que 06A.
 * Invariante: sin correo verificado no hay identidad EKKO; el registro público nunca
 * da rol, plan pagado, créditos, membresía, estudio ni un perfil de staff.
 */

let b: BaseDePrueba;
let admin: Persona;
let plan: string;
let planFueraDeVenta: string;
let n = 0;

type J = Record<string, unknown>;
const correo = () => `p06c-${++n}-${Date.now()}@test.mx`;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const metaPublica = (extra: J = {}) => JSON.stringify({ tenant_slug: 'ekko', nombre: 'Del registro', origen: 'alta_publica', plan, ...extra });

/** createUser(email_confirm=false) del alta pública. */
const authPendiente = (email: string, meta = metaPublica()) =>
  b.fila<{ id: string }>(
    `INSERT INTO auth.users (email, raw_user_meta_data, email_confirmed_at) VALUES ($1, $2::jsonb, NULL) RETURNING id`, [email, meta]
  ).then((x) => x.id);
/** El verify del proveedor: el dueño del buzón abrió el enlace. */
const confirmar = (authId: string) => b.db.query(`UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1`, [authId]);
const perfilDe = (authId: string) =>
  b.fila<{ id: string; rol: string; status: string; membresia_tier: string | null; tenant_id: string; nombre: string | null; membresia_activa_id: string | null; notas_admin: string | null }>(
    'SELECT id, rol, status, membresia_tier, tenant_id, nombre, membresia_activa_id, notas_admin FROM usuarios WHERE auth_id = $1', [authId]);
const perfilesCon = (email: string) => b.filas<{ id: string }>('SELECT id FROM usuarios WHERE lower(email) = lower($1)', [email]);
const solicitar = (email: string, origen: string | null = hex(`ip-${n}`), tier: string = plan) =>
  b.fila<{ r: J }>('SELECT alta_publica_solicitar($1, $2, $3, $4) AS r', [email, hex(`correo:${email}`), origen, tier]).then((x) => x.r);
const audits = (id: string, accion: string) =>
  b.filas<{ actor_rol: string; metadata: J }>(`SELECT actor_rol, metadata FROM audit_log WHERE target_id = $1 AND accion = $2`, [id, accion]);
const perfilSinAcceso = async (email: string, rol = 'miembro') =>
  (await b.fila<{ id: string }>(`INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES ($1, $2, 'Perfil previo', $3, 'pendiente_onboarding') RETURNING id`, [b.tenantId, email, rol])).id;
/** Envejece los intentos (la ventana es del servidor; el test no espera de verdad). */
const envejecer = (intervalo: string) => b.db.query(`UPDATE alta_publica_intentos SET creado_at = creado_at - $1::interval`, [intervalo]);
const limpiarIntentos = () => b.db.query('DELETE FROM alta_publica_intentos');

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  plan = (await b.fila<{ slug: string }>(`SELECT slug FROM tiers WHERE tenant_id = $1 AND activo AND en_venta ORDER BY slug LIMIT 1`, [b.tenantId])).slug;
  planFueraDeVenta = (await b.fila<{ slug: string }>(`SELECT slug FROM tiers WHERE tenant_id = $1 AND activo AND en_venta AND slug <> $2 ORDER BY slug LIMIT 1`, [b.tenantId, plan])).slug;
  await b.db.query(`UPDATE tiers SET en_venta = false WHERE tenant_id = $1 AND slug = $2`, [b.tenantId, planFueraDeVenta]);
  await b.db.query(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-06c', 'Otro estudio', 'activo')`);
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('sin correo verificado no hay identidad EKKO', () => {
  it('11/37 · una alta pendiente no crea perfil: la cuenta de Auth existe, la identidad EKKO no', async () => {
    const email = correo();
    const authId = await authPendiente(email);
    expect(await perfilDe(authId)).toBeUndefined();
    expect(await perfilesCon(email)).toEqual([]);
  });

  it('10/18 · un correo ajeno sin verificar NO reclama un perfil existente (ni cascarón)', async () => {
    const email = correo();
    const perfil = await perfilSinAcceso(email);
    const authId = await authPendiente(email);
    expect((await b.fila<{ auth_id: string | null }>('SELECT auth_id FROM usuarios WHERE id = $1', [perfil])).auth_id).toBeNull();
    expect(await perfilDe(authId)).toBeUndefined();
  });

  it('28 · una sesión sin correo verificado no cruza la frontera: no ve perfiles ni membresías y no actúa como miembro', async () => {
    const email = correo();
    const authId = await authPendiente(email);
    const sesion: Persona = { authId, id: '00000000-0000-0000-0000-000000000000' };
    expect(await b.como(sesion, () => b.filas('SELECT id FROM usuarios'))).toEqual([]);
    expect(await b.como(sesion, () => b.filas('SELECT id FROM membresias'))).toEqual([]);
    await expect(b.como(sesion, () => b.fila(`SELECT miembro_programar_renovacion(true, gen_random_uuid())`))).rejects.toThrow();
    await expect(b.como(sesion, () => b.db.query(
      `INSERT INTO usuarios (auth_id, tenant_id, email, rol, status) VALUES ($1, $2, $3, 'admin', 'activo')`, [authId, b.tenantId, email]))).rejects.toThrow();
  });
});

describe('la confirmación del correo es el único momento del alta', () => {
  it('12/16 · al confirmar nace UN perfil miembro / pendiente_pago con el plan elegido; sin membresía, créditos ni pago; con auditoría', async () => {
    const email = correo();
    const authId = await authPendiente(email);
    await confirmar(authId);
    const p = await perfilDe(authId);
    expect(p).toMatchObject({ rol: 'miembro', status: 'pendiente_pago', membresia_tier: plan, tenant_id: b.tenantId, nombre: 'Del registro', membresia_activa_id: null });
    expect(await b.filas('SELECT id FROM membresias WHERE usuario_id = $1', [p.id])).toEqual([]);
    expect(await b.filas('SELECT id FROM payment_events WHERE usuario_id = $1', [p.id])).toEqual([]);
    const [a] = await audits(p.id, 'alta_publica_verificada');
    expect(a).toMatchObject({ actor_rol: 'sistema', metadata: { auth_id: authId, plan } });
    expect(JSON.stringify(a.metadata)).not.toContain(email); // sin PII en la evidencia
  });

  it('13/14/19 · confirmación repetida (replay) o re-disparada: un solo perfil, sin duplicados ni segunda auditoría', async () => {
    const email = correo();
    const authId = await authPendiente(email);
    await confirmar(authId);
    await b.db.query(`UPDATE auth.users SET email_confirmed_at = NULL WHERE id = $1`, [authId]);
    await confirmar(authId);
    await b.db.query(`UPDATE auth.users SET email_confirmed_at = now() + interval '1 minute' WHERE id = $1`, [authId]);
    expect(await perfilesCon(email)).toHaveLength(1);
    expect(await audits((await perfilDe(authId)).id, 'alta_publica_verificada')).toHaveLength(1);
  });

  it('2/4/29–32 · la metadata no da rol, estudio, créditos, sanción ni Stripe; un plan fuera de venta no se cachea', async () => {
    const email = correo();
    const authId = await authPendiente(email, metaPublica({
      tenant_slug: 'b-06c', plan: planFueraDeVenta, rol: 'admin', status: 'activo', creditos: 99,
      stripe_customer_id: 'cus_x', sancionado_at: null, membresia_activa_id: 'x', nombre: 'N'.repeat(400)
    }));
    await confirmar(authId);
    const p = await perfilDe(authId);
    expect(p).toMatchObject({ rol: 'miembro', status: 'pendiente_pago', membresia_tier: null, tenant_id: b.tenantId, membresia_activa_id: null });
    expect(p.nombre).toHaveLength(120);
    expect(await b.fila<J>('SELECT sancionado_at, no_shows_count FROM usuarios WHERE id = $1', [p.id])).toMatchObject({ sancionado_at: null, no_shows_count: 0 });
    expect(await b.filas('SELECT id FROM membresias WHERE usuario_id = $1', [p.id])).toEqual([]); // ni créditos ni Stripe
  });

  it('17/20 · un cascarón sin historial se vincula al CONFIRMAR, sin reescribir rol, status ni plan (06A)', async () => {
    const email = correo();
    const perfil = await perfilSinAcceso(email);
    const authId = await authPendiente(email);
    await confirmar(authId);
    const u = await b.fila<J>('SELECT auth_id, rol, status, membresia_tier FROM usuarios WHERE id = $1', [perfil]);
    expect(u).toMatchObject({ auth_id: authId, rol: 'miembro', status: 'pendiente_onboarding', membresia_tier: null });
    const [v] = await audits(perfil, 'auth_vinculado');
    expect(v.metadata).toMatchObject({ auth_id: authId, origen: 'alta_publica' });
    expect(await perfilesCon(email)).toHaveLength(1);
  });

  it('20 · perfil con historial y sin autorización: la confirmación se rechaza ENTERA (el correo no queda verificado, nada se vincula)', async () => {
    const email = correo();
    const perfil = await perfilSinAcceso(email);
    await b.db.query(`INSERT INTO membresias (usuario_id, tenant_id, tier_id, status) VALUES ($1, $2, $3, 'cancelada')`, [perfil, b.tenantId, await b.tierId(plan)]);
    const authId = await authPendiente(email);
    await expect(confirmar(authId)).rejects.toThrow(/EKKO_PERFIL_CON_HISTORIAL/);
    expect((await b.fila<J>('SELECT email_confirmed_at FROM auth.users WHERE id = $1', [authId])).email_confirmed_at).toBeNull();
    expect((await b.fila<J>('SELECT auth_id FROM usuarios WHERE id = $1', [perfil])).auth_id).toBeNull();
  });

  it('9/33 · el alta pública nunca da acceso a un perfil de staff, aun con el correo verificado', async () => {
    for (const rol of ['recepcionista', 'admin']) {
      const email = correo();
      const perfil = await perfilSinAcceso(email, rol);
      const authId = await authPendiente(email);
      await expect(confirmar(authId)).rejects.toThrow(/EKKO_ALTA_PUBLICA_PERFIL_STAFF/);
      expect((await b.fila<J>('SELECT auth_id, rol FROM usuarios WHERE id = $1', [perfil]))).toMatchObject({ auth_id: null, rol });
    }
  });
});

describe('las altas del staff y los usuarios existentes no cambian', () => {
  it('21/42 · alta del staff (nace confirmada): cascarón pendiente_onboarding como en 06A, sin nota ni plan', async () => {
    const email = correo();
    const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, '{"tenant_slug":"ekko","nombre":"Staff"}') RETURNING id`, [email]);
    expect(await perfilDe(a.id)).toMatchObject({ rol: 'miembro', status: 'pendiente_onboarding', membresia_tier: null, notas_admin: null });
  });

  it('40 · una alta pendiente abandonada no bloquea a recepción: es la "cuenta de Auth sin perfil" que 06A ya limpia', async () => {
    const email = correo();
    const authId = await authPendiente(email);
    expect((await b.fila<{ r: string }>('SELECT auth_usuario_sin_perfil($1) AS r', [email])).r).toBe(authId);
  });

  it('43/44 · usuarios ya confirmados: un cambio de contraseña o correo no re-ejecuta el alta (sin re-vincular ni reescribir rol)', async () => {
    const antes = await b.fila<J>('SELECT rol, status FROM usuarios WHERE id = $1', [admin.id]);
    await b.db.query(`UPDATE auth.users SET encrypted_password = 'otro', email_confirmed_at = now() WHERE id = $1`, [admin.authId]);
    expect(await b.fila<J>('SELECT rol, status FROM usuarios WHERE id = $1', [admin.id])).toEqual(antes);
    expect(await b.filas('SELECT id FROM usuarios WHERE auth_id = $1', [admin.authId])).toHaveLength(1);
  });
});

describe('alta_publica_solicitar · límite y clasificación', () => {
  it('1 · correo nuevo → crear; guarda solo huellas HMAC (sin correo, IP ni token)', async () => {
    await limpiarIntentos();
    const email = correo();
    expect(await solicitar(email)).toMatchObject({ resultado: 'ok', accion: 'crear', motivo: 'nueva', plan });
    const filas = await b.filas<J>('SELECT * FROM alta_publica_intentos');
    expect(filas).toHaveLength(1);
    expect(Object.keys(filas[0]).sort()).toEqual(['clave_correo', 'clave_origen', 'creado_at', 'id', 'tenant_id']);
    expect(JSON.stringify(filas)).not.toContain(email);
  });

  it('8/23/27 · el mismo correo dentro del minuto = silencio (doble clic); pasado el minuto vuelve a servir; tope de 5 al día', async () => {
    await limpiarIntentos();
    const email = correo();
    expect(await solicitar(email)).toMatchObject({ accion: 'crear' });
    expect(await solicitar(email, hex('otra-ip'))).toEqual({ resultado: 'silencio' });
    for (let i = 0; i < 4; i++) {
      await envejecer('61 seconds');
      expect(await solicitar(email, hex(`ip-dia-${i}`))).toMatchObject({ resultado: 'ok' });
    }
    await envejecer('61 seconds');
    expect(await solicitar(email, hex('ip-sexta'))).toEqual({ resultado: 'silencio' });
    await envejecer('25 hours');
    expect(await solicitar(email, hex('ip-manana'))).toMatchObject({ resultado: 'ok' });
  });

  it('22/24/25 · ráfaga por origen: 5 en 10 min; cambiar el correo no la evade; pasada la ventana vuelve', async () => {
    await limpiarIntentos();
    const ip = hex('ip-rafaga');
    for (let i = 0; i < 5; i++) expect(await solicitar(correo(), ip)).toMatchObject({ resultado: 'ok' });
    expect(await solicitar(correo(), ip)).toEqual({ resultado: 'limitado', alcance: 'origen' });
    expect(await solicitar(correo(), hex('otra'))).toMatchObject({ resultado: 'ok' });
    await envejecer('11 minutes');
    expect(await solicitar(correo(), ip)).toMatchObject({ resultado: 'ok' });
  });

  it('24 · tope diario por origen (20) y techo del estudio (60 por hora)', async () => {
    await limpiarIntentos();
    const ip = hex('ip-dia');
    for (let i = 0; i < 20; i++) {
      expect(await solicitar(correo(), ip)).toMatchObject({ resultado: 'ok' });
      if (i % 5 === 4) await envejecer('11 minutes');
    }
    expect(await solicitar(correo(), ip)).toEqual({ resultado: 'limitado', alcance: 'origen' });
    await limpiarIntentos();
    for (let i = 0; i < 60; i++) expect(await solicitar(correo(), null)).toMatchObject({ resultado: 'ok' });
    expect(await solicitar(correo(), null)).toEqual({ resultado: 'limitado', alcance: 'global' });
    await envejecer('61 minutes');
    expect(await solicitar(correo(), null)).toMatchObject({ resultado: 'ok' });
  });

  it('26 · insistir por encima del límite no alarga el bloqueo (solo cuentan las aceptadas) y la purga borra lo de más de 24 h', async () => {
    await limpiarIntentos();
    const ip = hex('ip-insiste');
    for (let i = 0; i < 5; i++) await solicitar(correo(), ip);
    for (let i = 0; i < 10; i++) await solicitar(correo(), ip);
    expect((await b.fila<{ n: number }>('SELECT count(*)::int AS n FROM alta_publica_intentos')).n).toBe(5);
    await envejecer('25 hours');
    await solicitar(correo(), hex('x'));
    expect((await b.fila<{ n: number }>('SELECT count(*)::int AS n FROM alta_publica_intentos')).n).toBe(1);
  });

  it('6/7 · clasificación con el estado real (que nunca sale del servidor)', async () => {
    await limpiarIntentos();
    const pendiente = correo();
    const authPend = await authPendiente(pendiente);
    expect(await solicitar(pendiente)).toMatchObject({ accion: 'enlace', motivo: 'pendiente', auth_id: authPend });

    expect(await solicitar(await b.fila<{ email: string }>('SELECT email FROM usuarios WHERE id = $1', [admin.id]).then((x) => x.email)))
      .toMatchObject({ accion: 'ninguna', motivo: 'cuenta_existente' });

    const sinClave = correo();
    const authSin = await authPendiente(sinClave);
    await confirmar(authSin);
    expect(await solicitar(sinClave)).toMatchObject({ accion: 'enlace', motivo: 'sin_contrasena', auth_id: authSin });

    const cascaron = correo();
    await perfilSinAcceso(cascaron);
    expect(await solicitar(cascaron)).toMatchObject({ accion: 'crear', motivo: 'vincular' });

    const staff = correo();
    await perfilSinAcceso(staff, 'recepcionista');
    expect(await solicitar(staff)).toMatchObject({ accion: 'ninguna', motivo: 'perfil_staff' });

    const conHistorial = correo();
    const p = await perfilSinAcceso(conHistorial);
    await b.db.query(`INSERT INTO membresias (usuario_id, tenant_id, tier_id, status) VALUES ($1, $2, $3, 'cancelada')`, [p, b.tenantId, await b.tierId(plan)]);
    expect(await solicitar(conHistorial)).toMatchObject({ accion: 'ninguna', motivo: 'perfil_con_historial' });
  });

  it('plan inactivo / fuera de venta / inexistente, correo o huellas mal formados → error de dominio, sin registrar intento', async () => {
    await limpiarIntentos();
    await expect(solicitar(correo(), hex('a'), planFueraDeVenta)).rejects.toThrow(/EKKO_PLAN_NO_DISPONIBLE/);
    await expect(solicitar(correo(), hex('a'), 'no-existe')).rejects.toThrow(/EKKO_PLAN_NO_DISPONIBLE/);
    await expect(solicitar('sin-arroba', hex('a'))).rejects.toThrow(/EKKO_CORREO_INVALIDO/);
    await expect(b.fila(`SELECT alta_publica_solicitar($1, 'no-hex', NULL, $2)`, [correo(), plan])).rejects.toThrow(/EKKO_SOLICITUD_INVALIDA/);
    await expect(b.fila(`SELECT alta_publica_solicitar($1, $2, 'mal', $3)`, [correo(), hex('c'), plan])).rejects.toThrow(/EKKO_SOLICITUD_INVALIDA/);
    expect(await b.filas('SELECT id FROM alta_publica_intentos')).toEqual([]);
  });
});

describe('frontera de privilegios', () => {
  it('45/46/48 · la RPC es solo del servidor; la tabla de intentos no la toca ningún cliente; search_path fijo', async () => {
    const r = await b.fila<J>(`
      SELECT has_function_privilege('anon', 'alta_publica_solicitar(text,text,text,text)', 'EXECUTE') AS anon_x,
             has_function_privilege('authenticated', 'alta_publica_solicitar(text,text,text,text)', 'EXECUTE') AS auth_x,
             has_function_privilege('service_role', 'alta_publica_solicitar(text,text,text,text)', 'EXECUTE') AS svc_x,
             has_function_privilege('anon', 'handle_new_auth_user()', 'EXECUTE') AS anon_trg,
             has_function_privilege('authenticated', 'handle_new_auth_user()', 'EXECUTE') AS auth_trg,
             has_table_privilege('anon', 'alta_publica_intentos', 'SELECT') AS anon_sel,
             has_table_privilege('authenticated', 'alta_publica_intentos', 'SELECT') AS auth_sel,
             has_table_privilege('authenticated', 'alta_publica_intentos', 'INSERT') AS auth_ins,
             has_table_privilege('authenticated', 'alta_publica_intentos', 'DELETE') AS auth_del,
             (SELECT proconfig FROM pg_proc WHERE proname = 'alta_publica_solicitar') AS cfg,
             (SELECT prosecdef FROM pg_proc WHERE proname = 'alta_publica_solicitar') AS definer`);
    expect(r).toEqual({
      anon_x: false, auth_x: false, svc_x: true, anon_trg: false, auth_trg: false,
      anon_sel: false, auth_sel: false, auth_ins: false, auth_del: false, cfg: ['search_path=public'], definer: true
    });
    await expect(b.como(admin, () => b.fila(`SELECT alta_publica_solicitar('x@y.mx', $1, NULL, $2)`, [hex('z'), plan]))).rejects.toThrow(/permission denied/);
    await expect(b.como(admin, () => b.filas('SELECT * FROM alta_publica_intentos'))).rejects.toThrow(/permission denied/);
  });

  it('el trigger de confirmación existe en auth.users y solo dispara en la transición NULL → confirmado', async () => {
    const t = await b.fila<{ d: string }>(`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'on_auth_user_confirmed'`);
    expect(t.d).toMatch(/AFTER UPDATE OF email_confirmed_at ON auth\.users/);
    expect(t.d).toMatch(/old\.email_confirmed_at IS NULL/i);
    expect(t.d).toMatch(/handle_new_auth_user\(\)/);
  });
});
