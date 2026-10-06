// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-06A · migración 20261013100000 contra Postgres real (PGlite).
 *
 * La parte LOCAL de cada operación compuesta de cuenta (alta, rol, baja, reset,
 * edición) es UNA transacción con actor explícito y auditoría dentro. El proveedor
 * de Auth se simula como en producción: INSERT en auth.users → trigger de alta.
 *  · Vincular por correo solo a un perfil sin acceso y sin historial (cascarón) o
 *    autorizado explícitamente por un staff sobre ESE perfil.
 *  · D-FIN-1 = A: con historial durable o huella como staff no hay borrado físico.
 *  · Las RPC no son ejecutables por authenticated/anon: el actor no se forja.
 */

let b: BaseDePrueba;
let admin: Persona;
let recep: Persona;
let adminB: Persona;
let n = 0;

type J = Record<string, unknown>;
const correo = () => `p06a-${++n}-${Date.now()}@test.mx`;
const rpc = <T = J>(fn: string, args: unknown[]) =>
  b.fila<{ r: T }>(`SELECT ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args).then((x) => x.r);
const preparar = (actor: Persona, email: string, rol = 'miembro', perfilId: string | null = null) =>
  rpc('cuenta_alta_preparar', [actor.id, email, rol, perfilId]);
const finalizar = (actor: Persona, authId: string, rol: string, modo: string, tier: string | null = null) =>
  rpc('cuenta_alta_finalizar', [actor.id, authId, rol, tier, 'Nombre Alta', '667', modo]);
/** Lo que hace `auth.admin.createUser`: el trigger crea o vincula el perfil. */
const authCrear = (email: string) =>
  b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, '{"tenant_slug":"ekko","nombre":"Del signup"}') RETURNING id`, [email]).then((x) => x.id);
const usuario = (id: string) =>
  b.fila<{ id: string; auth_id: string | null; rol: string; status: string; membresia_tier: string | null; nombre: string | null; telefono: string | null; email: string; sancionado_at: string | null; bloqueado_hasta: string | null; no_shows_count: number; acceso_autorizado_at: string | null }>(
    'SELECT id, auth_id, rol, status, membresia_tier, nombre, telefono, email, sancionado_at, bloqueado_hasta, no_shows_count, acceso_autorizado_at FROM usuarios WHERE id = $1', [id]);
const porAuth = (authId: string) => b.fila<{ id: string }>('SELECT id FROM usuarios WHERE auth_id = $1', [authId]);
const audits = (targetId: string, accion?: string) =>
  b.filas<{ accion: string; actor_usuario_id: string | null; actor_rol: string; antes: J | null; despues: J | null; metadata: J | null; motivo: string | null }>(
    `SELECT accion, actor_usuario_id, actor_rol, antes, despues, metadata, motivo FROM audit_log WHERE target_tipo = 'usuario' AND target_id = $1 ${accion ? 'AND accion = $2' : ''} ORDER BY creada_at`,
    accion ? [targetId, accion] : [targetId]);
const avisos = (usuarioId: string) =>
  b.filas<{ tipo: string; leida: boolean; metadata: J }>('SELECT tipo, leida, metadata FROM notificaciones WHERE usuario_id = $1 ORDER BY creada_at', [usuarioId]);
/** Perfil SIN acceso (como un alta de mostrador anterior a Auth). */
const perfilSinAcceso = async (email: string, rol = 'miembro', status = 'pendiente_pago') =>
  (await b.fila<{ id: string }>(`INSERT INTO usuarios (tenant_id, email, nombre, rol, status) VALUES ($1, $2, 'Sin acceso', $3, $4) RETURNING id`, [b.tenantId, email, rol, status])).id;
const cambiarRol = (actor: Persona, target: string, rol: string) => rpc('cuenta_cambiar_rol', [actor.id, target, rol]);
const eliminar = (actor: Persona, target: string) => rpc('cuenta_eliminar', [actor.id, target, 'Cuenta de prueba']);
const actualizar = (actor: Persona, target: string, cambios: J, motivo: string | null = null) =>
  rpc('staff_actualizar_cuenta', [actor.id, target, JSON.stringify(cambios), motivo]);
const ops = (id: string) => b.filas<{ tipo: string; causa: string; estado: string }>('SELECT tipo, causa, estado FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 ORDER BY created_at', [id]);

beforeAll(async () => {
  b = await levantarBase();
  admin = await b.crearPersona({ rol: 'admin' });
  recep = await b.crearPersona({ rol: 'recepcionista' });
  await b.db.query(`INSERT INTO tenants (slug, nombre, status) VALUES ('b-06a', 'Otro', 'activo')`);
  const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('admin-b-06a@test.mx', '{"tenant_slug":"b-06a"}') RETURNING id`);
  const u = await b.fila<{ id: string }>(`UPDATE usuarios SET rol = 'admin', status = 'activo' WHERE auth_id = $1 RETURNING id`, [a.id]);
  adminB = { authId: a.id, id: u.id };
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('alta: preparar → Auth → finalizar', () => {
  it('1 · perfil nuevo: rol/status/plan quedan en la finalización, con aviso de contraseña y auditoría del actor (también la del trigger de R1)', async () => {
    const email = correo();
    expect(await preparar(admin, email, 'recepcionista')).toMatchObject({ modo: 'nueva' });
    const authId = await authCrear(email);
    const shell = await porAuth(authId);
    expect(await usuario(shell.id)).toMatchObject({ rol: 'miembro', status: 'pendiente_onboarding' });
    expect(await audits(shell.id, 'cuenta_creada')).toHaveLength(0); // sin finalizar no hay "éxito"

    const r = await finalizar(admin, authId, 'recepcionista', 'nueva');
    expect(r).toMatchObject({ success: true, idempotente: false, usuario_id: shell.id, rol: 'recepcionista', status: 'activo' });
    expect(await usuario(shell.id)).toMatchObject({ rol: 'recepcionista', status: 'activo', membresia_tier: null, nombre: 'Nombre Alta', telefono: '667' });
    const [creada] = await audits(shell.id, 'cuenta_creada');
    expect(creada).toMatchObject({ actor_usuario_id: admin.id, actor_rol: 'admin', despues: { rol: 'recepcionista', status: 'activo' } });
    expect(creada.metadata).toMatchObject({ auth_id: authId, modo: 'nueva' });
    // El trigger de auditoría de R1 ya no registra 'sistema': ve al actor real.
    const [estado] = await audits(shell.id, 'cuenta_estado_cambio');
    expect(estado).toMatchObject({ actor_usuario_id: admin.id, actor_rol: 'admin' });
    expect(await avisos(shell.id)).toEqual([expect.objectContaining({ tipo: 'cambiar_password', leida: false, metadata: { origen: 'alta' } })]);
  });

  it('1b · miembro: nace pendiente_pago con el plan pedido; recepción puede darlo de alta', async () => {
    const email = correo();
    expect(await preparar(recep, email, 'miembro')).toMatchObject({ modo: 'nueva' });
    const authId = await authCrear(email);
    const r = await finalizar(recep, authId, 'miembro', 'nueva', 'esencial');
    expect(r).toMatchObject({ rol: 'miembro', status: 'pendiente_pago' });
    expect((await usuario(r.usuario_id as string)).membresia_tier).toBe('esencial');
  });

  it('2 · cascarón sin acceso ni historial: se vincula (EKKO-095) y la finalización conserva rol/status/plan del perfil', async () => {
    const email = correo();
    const perfil = await perfilSinAcceso(email);
    await b.db.query(`UPDATE usuarios SET membresia_tier = 'premium' WHERE id = $1`, [perfil]);
    expect(await preparar(recep, email, 'miembro')).toMatchObject({ modo: 'vincular', perfil_id: perfil, historial: {} });
    const authId = await authCrear(email);
    expect((await usuario(perfil)).auth_id).toBe(authId);
    const r = await finalizar(recep, authId, 'miembro', 'vincular', 'esencial');
    expect(r).toMatchObject({ success: true, usuario_id: perfil, rol: 'miembro', status: 'pendiente_pago' });
    // No se reescribe lo que ya tenía: el plan sigue siendo el suyo, el nombre también.
    expect(await usuario(perfil)).toMatchObject({ membresia_tier: 'premium', nombre: 'Sin acceso', status: 'pendiente_pago' });
    expect(await audits(perfil, 'acceso_creado')).toHaveLength(1);
    expect(await audits(perfil, 'cuenta_creada')).toHaveLength(0);
  });

  it('3 · un miembro real con acceso y el mismo correo: "existente" antes de tocar Auth, y Auth tampoco lo roba', async () => {
    const m = await b.crearPersona();
    const { email } = await usuario(m.id);
    expect(await preparar(admin, email, 'miembro')).toMatchObject({ modo: 'existente', perfil_id: m.id });
    await expect(authCrear(email.toUpperCase())).rejects.toThrow(/EKKO_IDENTIDAD_AMBIGUA/);
    expect((await usuario(m.id)).auth_id).toBe(m.authId);
  });

  it('4 · perfil con historial (membresía) sin acceso: NO se adueña por el correo; con autorización explícita sobre ESE perfil sí, con marcador consumido y actor en la evidencia', async () => {
    const email = correo();
    const perfil = await perfilSinAcceso(email);
    await b.activar({ id: perfil, authId: '' }, 'esencial');
    expect(await preparar(recep, email, 'miembro')).toMatchObject({ modo: 'perfil_con_historial', perfil_id: perfil, historial: { membresias: 1 } });
    // Sin autorización, el alta en Auth se rechaza y el perfil queda intacto.
    await expect(authCrear(email)).rejects.toThrow(/EKKO_PERFIL_CON_HISTORIAL/);
    expect(await usuario(perfil)).toMatchObject({ auth_id: null, status: 'activo' });
    // Otro rol sobre el perfil: se rechaza antes de tocar Auth, sin marcador.
    expect(await preparar(admin, email, 'admin', perfil)).toMatchObject({ modo: 'rol_distinto', rol_perfil: 'miembro' });
    expect((await usuario(perfil)).acceso_autorizado_at).toBeNull();
    // Autorización explícita.
    expect(await preparar(recep, email, 'miembro', perfil)).toMatchObject({ modo: 'vincular', perfil_id: perfil, historial: { membresias: 1 } });
    expect((await usuario(perfil)).acceso_autorizado_at).not.toBeNull();
    expect((await audits(perfil, 'acceso_autorizado'))[0]).toMatchObject({ actor_usuario_id: recep.id });
    const authId = await authCrear(email);
    expect(await usuario(perfil)).toMatchObject({ auth_id: authId, status: 'activo', acceso_autorizado_at: null });
    const [vinc] = await audits(perfil, 'auth_vinculado');
    expect(vinc).toMatchObject({ actor_usuario_id: recep.id, actor_rol: 'recepcionista' });
    expect(vinc.metadata).toMatchObject({ auth_id: authId, historial: { membresias: 1 } });
    expect(vinc.metadata?.autorizado_at).toBeTruthy();
    const r = await finalizar(recep, authId, 'miembro', 'vincular');
    expect(r).toMatchObject({ success: true, status: 'activo' });
  });

  it('4b · el perfil indicado debe ser el de ese correo; recepción no da de alta staff', async () => {
    const email = correo();
    const otro = await perfilSinAcceso(correo());
    await expect(preparar(admin, email, 'miembro', otro)).rejects.toThrow(/EKKO_PERFIL_DISTINTO/);
    await expect(preparar(recep, email, 'recepcionista')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(preparar(admin, email, 'staff')).rejects.toThrow(/EKKO_ROL_INVALIDO/);
  });

  it('6/7 · alta a medias (Auth sí, finalización no): el reintento recupera con el modo original y no deja evidencia doble', async () => {
    const email = correo();
    expect(await preparar(admin, email, 'recepcionista')).toMatchObject({ modo: 'nueva' });
    const authId = await authCrear(email);
    // …la finalización no ocurrió. Segundo intento con el mismo correo:
    const p2 = await preparar(admin, email, 'recepcionista');
    expect(p2).toMatchObject({ modo: 'recuperar', modo_original: 'nueva', auth_id: authId });
    const r = await finalizar(admin, authId, 'recepcionista', 'nueva');
    expect(r).toMatchObject({ success: true, idempotente: false, rol: 'recepcionista' });
    // Tercer intento: la cuenta ya es real → existente; finalizar otra vez es idempotente.
    expect(await preparar(admin, email, 'recepcionista')).toMatchObject({ modo: 'existente' });
    expect(await finalizar(admin, authId, 'recepcionista', 'nueva')).toMatchObject({ idempotente: true });
    expect(await audits(r.usuario_id as string, 'cuenta_creada')).toHaveLength(1);
    expect(await avisos(r.usuario_id as string)).toHaveLength(1);
  });

  it('7b · una cuenta real anterior a 06A (sin evidencia de alta) NUNCA se "recupera": es existente', async () => {
    const m = await b.crearPersona({ rol: 'miembro', status: 'activo' });
    const { email } = await usuario(m.id);
    expect(await preparar(admin, email, 'admin')).toMatchObject({ modo: 'existente' });
    expect((await usuario(m.id)).rol).toBe('miembro');
  });

  it('finalizar exige que el perfil exista y sea del tenant del actor; un cascarón de otro tenant no se toca', async () => {
    await expect(finalizar(admin, '00000000-0000-0000-0000-000000000001', 'miembro', 'nueva')).rejects.toThrow(/EKKO_PERFIL_NO_ENCONTRADO/);
    const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, '{"tenant_slug":"b-06a"}') RETURNING id`, [correo()]);
    await expect(finalizar(admin, a.id, 'miembro', 'nueva')).rejects.toThrow(/EKKO_TENANT_DIFERENTE/);
  });
});

describe('baja: D-FIN-1 = A', () => {
  it('11/18 · cuenta desechable: se borra con evidencia previa que sobrevive (actor, auth_id, sin PII)', async () => {
    const email = correo();
    await preparar(admin, email, 'miembro');
    const authId = await authCrear(email);
    const r = await finalizar(admin, authId, 'miembro', 'nueva');
    const id = r.usuario_id as string;
    const e = await eliminar(admin, id);
    expect(e).toMatchObject({ permitido: true, usuario_id: id, auth_id: authId });
    expect(await usuario(id)).toBeUndefined();
    const [ev] = await audits(id, 'cuenta_eliminada');
    expect(ev).toMatchObject({ actor_usuario_id: admin.id, actor_rol: 'admin', motivo: 'Cuenta de prueba', antes: { rol: 'miembro', status: 'pendiente_pago' } });
    expect(ev.metadata).toMatchObject({ auth_id: authId, tenia_acceso: true });
    expect(JSON.stringify(ev)).not.toContain(email);
  });

  it('12/16 · membresía (con suscripción de Stripe) bloquea: nada cambia y se dice por qué', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: `sub_06a_${++n}`, fin: '2099-01-01' });
    const e = await eliminar(admin, m.id);
    expect(e).toMatchObject({ permitido: false, historial: { membresias: 1 } });
    expect(await usuario(m.id)).toBeDefined();
    expect(await audits(m.id, 'cuenta_eliminada')).toHaveLength(0);
  });

  it('13 · ledger de créditos bloquea aunque la membresía se haya cerrado', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    expect((await b.fila<{ n: number }>('SELECT count(*)::int AS n FROM membresia_movimientos WHERE usuario_id = $1', [m.id])).n).toBeGreaterThan(0);
    const e = await eliminar(admin, m.id);
    expect(e.permitido).toBe(false);
    expect((e.historial as J).movimientos).toBeGreaterThan(0);
  });

  it('14 · evidencia de pago bloquea', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.db.query(`INSERT INTO payment_events (stripe_event_id, stripe_event_type, usuario_id, raw_payload, status) VALUES ($1, 'invoice.paid', $2, '{}', 'succeeded')`, [`evt_06a_${++n}`, m.id]);
    expect(await eliminar(admin, m.id)).toMatchObject({ permitido: false, historial: { pagos: 1 } });
  });

  it('15 · reservas en historial bloquean', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    const recurso = await b.crearEstudio();
    const slot = await b.slot(2, 11);
    await b.como(recep, () => b.fila('SELECT reservar_para_miembro_atomic($1, $2, $3::timestamptz, 60, 0, NULL)', [m.id, recurso, slot]));
    const e = await eliminar(admin, m.id);
    expect(e.permitido).toBe(false);
    expect((e.historial as J).reservas).toBe(1);
  });

  it('16b · cliente de Stripe o notas del equipo también son historial', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.db.query(`INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, stripe_customer_id) VALUES ($1, $2, 'cus_x')`, [m.id, b.tenantId]);
    expect(await eliminar(admin, m.id)).toMatchObject({ permitido: false, historial: { cliente_stripe: 1 } });
    const m2 = await b.crearPersona({ status: 'pendiente_pago' });
    await b.db.query(`INSERT INTO notas_miembro (tenant_id, miembro_id, autor_id, autor_rol, contenido) VALUES ($1, $2, $3, 'admin', 'Nota')`, [b.tenantId, m2.id, admin.id]);
    expect(await eliminar(admin, m2.id)).toMatchObject({ permitido: false, historial: { notas: 1 } });
  });

  it('huella como staff bloquea (bitácora, check-ins…): al equipo se le revoca', async () => {
    const e = await eliminar(admin, recep.id);
    expect(e.permitido).toBe(false);
    expect(Object.keys(e.huella_staff as J).length).toBeGreaterThan(0);
  });

  it('autoridad: solo un admin activo del mismo tenant, nunca a sí mismo', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await expect(eliminar(recep, m.id)).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(eliminar(adminB, m.id)).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
    await expect(eliminar(admin, admin.id)).rejects.toThrow(/EKKO_PROPIO/);
    expect(await usuario(m.id)).toBeDefined();
  });

  it('19 · último admin: el trigger de R1 sigue siendo la autoridad (DELETE y degradación directos fallan)', async () => {
    await expect(b.db.query('DELETE FROM usuarios WHERE id = $1', [adminB.id])).rejects.toThrow(/EKKO_ULTIMO_ADMIN/);
    await expect(b.db.query(`UPDATE usuarios SET rol = 'miembro' WHERE id = $1`, [adminB.id])).rejects.toThrow(/EKKO_ULTIMO_ADMIN/);
  });

  it('20 · ni la RPC ni el DELETE directo están al alcance del cliente', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await expect(b.como(admin, () => b.fila('SELECT cuenta_eliminar($1, $2, NULL)', [admin.id, m.id]))).rejects.toThrow(/permission denied/);
    await b.como(admin, () => b.db.query('DELETE FROM usuarios WHERE id = $1', [m.id])).catch(() => undefined);
    expect(await usuario(m.id)).toBeDefined();
  });
});

describe('rol: una transacción con actor', () => {
  it('21/22 · admin cambia el rol: fila, evidencia rol_cambiado con actor y evidencia del trigger con actor', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    const r = await cambiarRol(admin, m.id, 'recepcionista');
    expect(r).toMatchObject({ success: true, idempotente: false, rol: 'recepcionista', status: 'activo' }); // pendiente_* → activo al ascender
    const [ev] = await audits(m.id, 'rol_cambiado');
    expect(ev).toMatchObject({ actor_usuario_id: admin.id, antes: { rol: 'miembro', status: 'pendiente_pago' }, despues: { rol: 'recepcionista', status: 'activo' } });
    expect((await audits(m.id, 'cuenta_estado_cambio')).at(-1)).toMatchObject({ actor_usuario_id: admin.id });
  });

  it('un revocado no se reactiva por cambiarle el rol', async () => {
    const m = await b.crearPersona();
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    expect(await cambiarRol(admin, m.id, 'recepcionista')).toMatchObject({ rol: 'recepcionista', status: 'revocado' });
  });

  it('23/24 · otro tenant → inválido; recepción → no autorizado; a sí mismo → no', async () => {
    const m = await b.crearPersona();
    await expect(cambiarRol(adminB, m.id, 'admin')).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
    await expect(cambiarRol(recep, m.id, 'admin')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    await expect(cambiarRol(admin, admin.id, 'miembro')).rejects.toThrow(/EKKO_PROPIO_ROL/);
    await expect(cambiarRol(admin, m.id, 'staff')).rejects.toThrow(/EKKO_ROL_INVALIDO/);
    expect((await usuario(m.id)).rol).toBe('miembro');
  });

  it('26 · repetir el mismo rol es idempotente: una sola evidencia', async () => {
    const m = await b.crearPersona();
    await cambiarRol(admin, m.id, 'recepcionista');
    expect(await cambiarRol(admin, m.id, 'recepcionista')).toMatchObject({ idempotente: true });
    expect(await audits(m.id, 'rol_cambiado')).toHaveLength(1);
  });

  it('37 · el cliente no ejecuta la RPC (el actor no se forja)', async () => {
    const m = await b.crearPersona();
    await expect(b.como(m, () => b.fila('SELECT cuenta_cambiar_rol($1, $2, $3)', [admin.id, m.id, 'admin']))).rejects.toThrow(/permission denied/);
  });
});

describe('contraseña reseteada: evidencia + aviso después de Auth', () => {
  it('27/30 · recepción sobre un miembro: audit con actor y aviso cambiar_password; el cambio real de contraseña lo cierra (02C)', async () => {
    const m = await b.crearPersona();
    expect(await rpc('cuenta_password_reseteada', [recep.id, m.id, 'Olvidó su clave'])).toMatchObject({ success: true });
    expect((await audits(m.id, 'password_reset'))[0]).toMatchObject({ actor_usuario_id: recep.id, actor_rol: 'recepcionista', motivo: 'Olvidó su clave', antes: null, despues: null });
    expect(await avisos(m.id)).toEqual([expect.objectContaining({ tipo: 'cambiar_password', leida: false, metadata: { origen: 'reset' } })]);
    await b.db.query(`UPDATE auth.users SET encrypted_password = 'hash-nuevo' WHERE id = $1`, [m.authId]);
    expect((await avisos(m.id))[0].leida).toBe(true);
  });

  it('escalada: recepción no resetea al equipo; un admin sí; sin acceso no hay nada que resetear', async () => {
    const otraRecep = await b.crearPersona({ rol: 'recepcionista' });
    await expect(rpc('cuenta_password_reseteada', [recep.id, otraRecep.id, null])).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    expect(await rpc('cuenta_password_reseteada', [admin.id, otraRecep.id, null])).toMatchObject({ success: true });
    const sinAcceso = await perfilSinAcceso(correo());
    await expect(rpc('cuenta_password_reseteada', [recep.id, sinAcceso, null])).rejects.toThrow(/EKKO_SIN_ACCESO/);
    const m = await b.crearPersona();
    await expect(rpc('cuenta_password_reseteada', [adminB.id, m.id, null])).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
  });
});

describe('edición de cuenta por staff: la parte local en una transacción', () => {
  it('31 · contacto sin motivo: nombre/teléfono y evidencia contact_change con actor', async () => {
    const m = await b.crearPersona();
    const r = await actualizar(recep, m.id, { nombre: 'Ana María', telefono: '6671' });
    expect(r).toMatchObject({ success: true, sin_cambios: false, cambios: ['nombre', 'teléfono'] });
    expect(await usuario(m.id)).toMatchObject({ nombre: 'Ana María', telefono: '6671' });
    const [c] = await audits(m.id, 'contact_change');
    expect(c).toMatchObject({ actor_usuario_id: recep.id, antes: { nombre: 'Persona de prueba' }, despues: { nombre: 'Ana María', telefono: '6671' } });
    expect(await actualizar(recep, m.id, { nombre: 'Ana María' })).toMatchObject({ sin_cambios: true });
  });

  it('32 · copia local del correo (la función la llama DESPUÉS de Auth) con evidencia', async () => {
    const m = await b.crearPersona();
    const nuevo = correo();
    const r = await actualizar(admin, m.id, { email: nuevo.toUpperCase() });
    expect(r).toMatchObject({ cambios: ['email'] });
    expect((await usuario(m.id)).email).toBe(nuevo);
    expect((await audits(m.id, 'contact_change'))[0].despues).toMatchObject({ email: nuevo });
    await expect(actualizar(admin, m.id, { email: 'sin-arroba' })).rejects.toThrow(/EKKO_EMAIL_INVALIDO/);
  });

  it('34 · suspender = sanción (suspende el cobro por R2-B); activar la levanta (reanuda); el audit dice el estado REAL', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: `sub_06a_${++n}`, fin: '2099-01-01' });
    await expect(actualizar(recep, m.id, { status: 'suspendido' })).rejects.toThrow(/EKKO_MOTIVO_REQUERIDO/);
    const r = await actualizar(recep, m.id, { status: 'suspendido' }, 'Daños al equipo');
    expect(r).toMatchObject({ status: 'suspendido', cambios: ['status→suspendido'] });
    expect((await usuario(m.id)).sancionado_at).not.toBeNull();
    expect((await ops(m.id)).map((o) => [o.tipo, o.causa])).toEqual([['suspender_cobro', 'sancion']]);
    const [s1] = await audits(m.id, 'status_change');
    expect(s1).toMatchObject({ actor_usuario_id: recep.id, antes: { status: 'activo', sancionado: false }, despues: { status: 'suspendido', sancionado: true }, motivo: 'Daños al equipo' });

    // Levantar la sanción antes de que la suspensión llegara a Stripe: R2-B la
    // descarta (no hace falta reanudar lo que nunca se suspendió). Con la
    // suspensión APLICADA, se crea la reanudación.
    const r2 = await actualizar(recep, m.id, { status: 'activo' }, 'Pagó los daños');
    expect(r2).toMatchObject({ status: 'activo' });
    expect((await usuario(m.id)).sancionado_at).toBeNull();
    expect((await ops(m.id)).map((o) => [o.tipo, o.estado])).toEqual([['suspender_cobro', 'descartada']]);

    await actualizar(recep, m.id, { status: 'suspendido' }, 'Reincidió');
    const pendiente = await b.fila<{ id: string; tipo: string }>(`SELECT id, tipo FROM stripe_operaciones_suscripcion WHERE usuario_id = $1 AND estado = 'pendiente'`, [m.id]);
    expect(pendiente.tipo).toBe('suspender_cobro');
    // El ejecutor con Stripe "OK" (R2-B): preparar + resultado.
    await b.fila('SELECT operacion_suscripcion_preparar($1)', [pendiente.id]);
    await b.fila(`SELECT operacion_suscripcion_resultado($1, true, NULL, '{}'::jsonb)`, [pendiente.id]);
    await actualizar(recep, m.id, { status: 'activo' }, 'Pagó');
    expect((await ops(m.id)).map((o) => [o.tipo, o.estado])).toEqual([['suspender_cobro', 'descartada'], ['suspender_cobro', 'aplicada'], ['reanudar_cobro', 'pendiente']]);
  });

  it('34b · desbloqueo con motivo: bloqueado_hasta=NULL y NO resetea no_shows_count (B4); sin motivo → error', async () => {
    const m = await b.crearPersona();
    await b.db.query(`UPDATE usuarios SET bloqueado_hasta = now() + interval '3 days', no_shows_count = 2 WHERE id = $1`, [m.id]);
    await expect(actualizar(recep, m.id, { unblock: true })).rejects.toThrow(/EKKO_MOTIVO_REQUERIDO/);
    expect(await actualizar(recep, m.id, { unblock: true }, 'Avisó con tiempo')).toMatchObject({ cambios: ['desbloqueo'] });
    expect(await usuario(m.id)).toMatchObject({ bloqueado_hasta: null, no_shows_count: 2 });
    expect((await audits(m.id, 'unblock'))[0].despues).toMatchObject({ bloqueado_hasta: null, no_shows_count: 2 });
  });

  it('35 · revocación: recepción no la levanta; un admin sí, por restaurar_acceso_revocado dentro de la misma transacción', async () => {
    const m = await b.crearPersona();
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    await expect(actualizar(recep, m.id, { status: 'activo' }, 'Volvió')).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    expect((await usuario(m.id)).status).toBe('revocado');
    const r = await actualizar(admin, m.id, { status: 'activo' }, 'Revocación por error');
    expect(r).toMatchObject({ status: 'activo' });
    expect((await audits(m.id, 'acceso_restaurado'))[0]).toMatchObject({ actor_usuario_id: admin.id });
    expect((await audits(m.id, 'status_change'))[0].despues).toMatchObject({ status: 'activo' });
  });

  it('35b · sancionar a un revocado deja la sanción pero el estado sigue revocado (el audit lo dice)', async () => {
    const m = await b.crearPersona();
    await b.db.query(`UPDATE usuarios SET status = 'revocado' WHERE id = $1`, [m.id]);
    const r = await actualizar(admin, m.id, { status: 'suspendido' }, 'Daños');
    expect(r).toMatchObject({ status: 'revocado' });
    expect((await usuario(m.id)).sancionado_at).not.toBeNull();
    expect((await audits(m.id, 'status_change'))[0].despues).toMatchObject({ status: 'revocado', sancionado: true });
  });

  it('36 · otro tenant, equipo por recepción, plan y status inválidos: rechazados sin cambios', async () => {
    const m = await b.crearPersona();
    await expect(actualizar(adminB, m.id, { nombre: 'X' })).rejects.toThrow(/EKKO_MIEMBRO_INVALIDO/);
    await expect(actualizar(recep, admin.id, { nombre: 'X' })).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    expect(await actualizar(admin, recep.id, { telefono: '1' })).toMatchObject({ cambios: ['teléfono'] });
    await expect(actualizar(recep, m.id, { membresia_tier: 'premium' })).rejects.toThrow(/EKKO_PLAN_NO_EDITABLE/);
    await expect(actualizar(recep, m.id, { status: 'cancelado' }, 'x'.repeat(3))).rejects.toThrow(/EKKO_STATUS_INVALIDO/);
    expect((await usuario(m.id)).nombre).toBe('Persona de prueba');
  });

  it('la foto queda con evidencia y identidad_completa la recalcula el trigger', async () => {
    const m = await b.crearPersona();
    expect(await actualizar(recep, m.id, { avatar_url: 'https://cdn.test/a.jpg' })).toMatchObject({ cambios: ['foto'], avatar_url: 'https://cdn.test/a.jpg' });
    expect((await audits(m.id, 'avatar_change'))[0].despues).toEqual({ avatar_url: 'https://cdn.test/a.jpg' });
  });
});

describe('38 · frontera: las RPC de cuenta no son del cliente', () => {
  it('ni authenticated ni anon ejecutan ninguna; service_role sí', async () => {
    const firmas = [
      'cuenta_alta_preparar(uuid, text, text, uuid)', 'cuenta_alta_finalizar(uuid, uuid, text, text, text, text, text)',
      'cuenta_cambiar_rol(uuid, uuid, text)', 'cuenta_eliminar(uuid, uuid, text)', 'cuenta_password_reseteada(uuid, uuid, text)',
      'staff_actualizar_cuenta(uuid, uuid, jsonb, text)', 'auth_usuario_sin_perfil(text)', 'cuenta_historial_durable(uuid)',
      '_cuenta_huella_staff(uuid)', '_cuenta_actor(uuid, text[])', '_cuenta_avisar_cambiar_password(uuid, uuid, text)'
    ];
    for (const f of firmas) {
      const p = await b.fila<{ a: boolean; an: boolean; s: boolean }>(
        `SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS a, has_function_privilege('anon', $1, 'EXECUTE') AS an, has_function_privilege('service_role', $1, 'EXECUTE') AS s`, [f]);
      expect([f, p.a, p.an, p.s]).toEqual([f, false, false, true]);
    }
  });

  it('auth_usuario_sin_perfil: solo una cuenta de Auth sin ningún perfil', async () => {
    const m = await b.crearPersona();
    const { email } = await usuario(m.id);
    expect(await rpc<string | null>('auth_usuario_sin_perfil', [email])).toBeNull();
    const suelto = correo();
    await b.db.query(`ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created`);
    const a = await b.fila<{ id: string }>(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [suelto]);
    await b.db.query(`ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created`);
    expect(await rpc<string | null>('auth_usuario_sin_perfil', [suelto.toUpperCase()])).toBe(a.id);
  });
});
