// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * Fase 1 de identidad única (2026-09-25, migraciones 20260925*):
 *  · la SANCIÓN administrativa (usuarios.sancionado_at) manda sobre cualquier
 *    operación de membresía: activar, cobro por webhook, pausar/reanudar;
 *  · un revocado no vuelve por una activación;
 *  · el miembro no toca avatar_url / contrato_firmado_at / sanción;
 *  · identidad_completa se mantiene coherente por trigger (foto por RLS de admin);
 *  · el alta en Auth VINCULA una fila sin auth_id y falla si es ambigua;
 *  · correo único por estudio sin importar mayúsculas.
 */

let b: BaseDePrueba;
let recep: Persona;
let admin: Persona;

beforeAll(async () => {
  b = await levantarBase();
  recep = await b.crearPersona({ rol: 'recepcionista' });
  admin = await b.crearPersona({ rol: 'admin' });
}, 120_000);

const sancionar = (m: Persona) =>
  b.fila("UPDATE usuarios SET sancionado_at = now(), sancion_motivo = 'Daños al equipo' WHERE id = $1", [m.id]);
const levantarSancion = (m: Persona) =>
  b.fila("UPDATE usuarios SET sancionado_at = NULL, sancion_motivo = NULL, status = 'activo' WHERE id = $1", [m.id]);
const status = async (m: Persona) => (await b.estadoUsuario(m)).status;
const vivas = (m: Persona) =>
  b.filas<{ status: string }>(
    "SELECT status FROM membresias WHERE usuario_id = $1 AND status IN ('trialing','activa','past_due','pausada')",
    [m.id]
  );
const pausar = (m: Persona, pausar: boolean) =>
  b.como(recep, () => b.fila('SELECT staff_pausar_membresia($1, $2, $3) AS r', [m.id, pausar, 'Viaje largo']));

describe('sanción administrativa vs membresía', () => {
  it('poner la sanción deja la cuenta suspendida aunque el escritor no toque status', async () => {
    const m = await b.crearPersona();
    await sancionar(m);
    expect(await status(m)).toBe('suspendido');
  });

  it('activar_membresia (mostrador o webhook) sobre un sancionado: la membresía existe, el acceso sigue suspendido', async () => {
    const m = await b.crearPersona();
    await sancionar(m);
    const r = await b.activar(m, 'esencial', { id: 'sub_sancion_act', fin: '2099-01-01' });
    expect(r.success).toBe(true);
    expect((await vivas(m)).length).toBe(1);
    expect(await status(m)).toBe('suspendido');
  });

  it('webhook: invoice.paid (sync activa) sobre un sancionado NO reactiva', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_sancion_sync', fin: '2099-01-01' });
    await sancionar(m);
    await b.fila("SELECT sync_membresia_stripe('sub_sancion_sync', 'activa', '2099-02-01', NULL, now())");
    expect(await status(m)).toBe('suspendido');
  });

  it('webhook: suscripción cancelada sobre un sancionado: pierde el plan pero sigue suspendido (no "cancelado")', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial', { id: 'sub_sancion_cancel', fin: '2099-01-01' });
    await sancionar(m);
    await b.fila("SELECT sync_membresia_stripe('sub_sancion_cancel', 'cancelada', NULL, NULL, now())");
    const e = await b.estadoUsuario(m);
    expect(e.status).toBe('suspendido');
    expect(e.membresia_tier).toBeNull();
  });

  it('pausar y reanudar sobre un sancionado: no obtiene acceso', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await sancionar(m);
    await pausar(m, true);
    expect(await status(m)).toBe('suspendido');
    await pausar(m, false);
    expect((await vivas(m))[0].status).toBe('activa');
    expect(await status(m)).toBe('suspendido');
  });

  it('levantar la sanción (sancionado_at = NULL + activo en el mismo UPDATE) sí reactiva', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'esencial');
    await sancionar(m);
    await levantarSancion(m);
    expect(await status(m)).toBe('activo');
  });

  it('un revocado no vuelve a "activo" por una activación de membresía', async () => {
    const m = await b.crearPersona({ rol: 'recepcionista', status: 'revocado' });
    await b.activar(m, 'esencial');
    expect(await status(m)).toBe('revocado');
  });

  it('miembro normal: la activación válida sigue funcionando y puede reservar', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.activar(m, 'esencial');
    expect(await status(m)).toBe('activo');
    const estudio = await b.crearEstudio();
    const r = await b.reservar(m, estudio, await b.slot(3));
    expect(r.success).toBe(true);
  });

  it('un cobro por webhook sigue reactivando a quien estaba pendiente de pago (sin sanción)', async () => {
    const m = await b.crearPersona({ status: 'pendiente_pago' });
    await b.activar(m, 'esencial', { id: 'sub_normal_sync', fin: '2099-01-01' });
    await b.fila("UPDATE usuarios SET status = 'cancelado' WHERE id = $1", [m.id]);
    await b.fila("SELECT sync_membresia_stripe('sub_normal_sync', 'activa', '2099-02-01', NULL, now())");
    expect(await status(m)).toBe('activo');
  });
});

describe('identidad protegida', () => {
  it('el miembro no puede cambiarse avatar_url, contrato_firmado_at ni la sanción por PostgREST', async () => {
    const m = await b.crearPersona();
    for (const set of [
      "avatar_url = 'https://x/otra.jpg'",
      "contrato_firmado_at = now()",
      'sancionado_at = now()',
      "sancion_motivo = 'x'"
    ]) {
      await expect(
        b.como(m, () => b.fila(`UPDATE usuarios SET ${set} WHERE id = $1`, [m.id]))
      ).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    }
  });

  it('el miembro sigue editando nombre y teléfono', async () => {
    const m = await b.crearPersona();
    await b.como(m, () => b.fila("UPDATE usuarios SET nombre = 'Ana', telefono = '667' WHERE id = $1", [m.id]));
    const r = await b.fila<{ nombre: string; telefono: string }>('SELECT nombre, telefono FROM usuarios WHERE id = $1', [m.id]);
    expect(r).toMatchObject({ nombre: 'Ana', telefono: '667' });
  });

  it('la foto subida por un admin vía RLS deja identidad_completa coherente (sube y baja)', async () => {
    const m = await b.crearPersona();
    // Ficha completa salvo la foto (el trigger de datos privados recalcula → false).
    await b.fila(
      `INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, fecha_nacimiento, domicilio, ine_foto_path)
       VALUES ($1, $2, '1990-05-05', 'Calle 1', 't/ine.jpg')`,
      [m.id, b.tenantId]
    );
    await b.fila('UPDATE usuarios SET avatar_url = NULL WHERE id = $1', [m.id]);
    expect((await b.identidad(m)).identidad_completa).toBe(false);

    await b.como(admin, () => b.fila("UPDATE usuarios SET avatar_url = 'https://cdn/x.jpg' WHERE id = $1", [m.id]));
    expect((await b.identidad(m)).identidad_completa).toBe(true);

    await b.como(admin, () => b.fila('UPDATE usuarios SET avatar_url = NULL WHERE id = $1', [m.id]));
    expect((await b.identidad(m)).identidad_completa).toBe(false);
  });

  it('sin foto de INE la ficha no está completa aunque tenga foto de perfil y datos', async () => {
    const m = await b.crearPersona();
    await b.fila("UPDATE usuarios SET avatar_url = 'https://cdn/y.jpg' WHERE id = $1", [m.id]);
    await b.fila(
      `INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, fecha_nacimiento, domicilio)
       VALUES ($1, $2, '1990-05-05', 'Calle 1')`,
      [m.id, b.tenantId]
    );
    expect((await b.identidad(m)).identidad_completa).toBe(false);
    await b.fila("UPDATE usuarios_datos_privados SET ine_foto_path = 't/ine.jpg' WHERE usuario_id = $1", [m.id]);
    expect((await b.identidad(m)).identidad_completa).toBe(true);
  });
});

describe('alta en Auth: vincular filas sin auth_id, nunca robar', () => {
  it('fila existente sin auth_id + mismo correo con otra capitalización → LINK, una sola fila, audit', async () => {
    const email = `Link.Uno-${Date.now()}@Test.MX`;
    const fila = await b.fila<{ id: string }>(
      `INSERT INTO usuarios (tenant_id, email, nombre, rol, status)
       VALUES ($1, $2, 'Creada sin acceso', 'miembro', 'pendiente_pago') RETURNING id`,
      [b.tenantId, email]
    );
    const a = await b.fila<{ id: string }>(
      `INSERT INTO auth.users (email, raw_user_meta_data)
       VALUES ($1, '{"tenant_slug":"ekko","nombre":"Nombre del signup","telefono":"667"}') RETURNING id`,
      [email.toLowerCase()]
    );
    const filas = await b.filas<{ id: string; auth_id: string; status: string; nombre: string; telefono: string; email: string }>(
      'SELECT id, auth_id, status, nombre, telefono, email FROM usuarios WHERE lower(email) = lower($1)',
      [email]
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ id: fila.id, auth_id: a.id, status: 'pendiente_pago', nombre: 'Creada sin acceso', telefono: '667', email: email.toLowerCase() });
    const audit = await b.fila<{ accion: string }>(
      "SELECT accion FROM audit_log WHERE target_id = $1 AND accion = 'auth_vinculado'",
      [fila.id]
    );
    expect(audit?.accion).toBe('auth_vinculado');
  });

  it('el correo ya pertenece a OTRA cuenta de acceso → el alta falla y no se roba el auth_id', async () => {
    const m = await b.crearPersona();
    const { email, auth_id } = await b.fila<{ email: string; auth_id: string }>('SELECT email, auth_id FROM usuarios WHERE id = $1', [m.id]);
    await expect(
      b.fila(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, '{"tenant_slug":"ekko"}')`, [email.toUpperCase()])
    ).rejects.toThrow(/EKKO_IDENTIDAD_AMBIGUA/);
    const r = await b.fila<{ auth_id: string }>('SELECT auth_id FROM usuarios WHERE id = $1', [m.id]);
    expect(r.auth_id).toBe(auth_id);
  });

  it('alta normal: crea la fila con el correo normalizado', async () => {
    const email = `  Nueva.Alta-${Date.now()}@Test.MX `;
    const a = await b.fila<{ id: string }>(
      `INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, '{"tenant_slug":"ekko","nombre":"  Con espacios "}') RETURNING id`,
      [email]
    );
    const u = await b.fila<{ email: string; nombre: string; status: string }>('SELECT email, nombre, status FROM usuarios WHERE auth_id = $1', [a.id]);
    expect(u).toMatchObject({ email: email.trim().toLowerCase(), nombre: 'Con espacios', status: 'pendiente_onboarding' });
  });

  it('correo NULL o sin @ → el alta en Auth falla con EKKO_EMAIL_INVALIDO y no crea fila', async () => {
    const antes = await b.fila<{ n: number }>('SELECT count(*)::int AS n FROM usuarios');
    await expect(
      b.fila(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES (NULL, '{"tenant_slug":"ekko"}')`)
    ).rejects.toThrow(/EKKO_EMAIL_INVALIDO/);
    await expect(
      b.fila(`INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('sin-arroba', '{"tenant_slug":"ekko"}')`)
    ).rejects.toThrow(/EKKO_EMAIL_INVALIDO/);
    const despues = await b.fila<{ n: number }>('SELECT count(*)::int AS n FROM usuarios');
    expect(despues.n).toBe(antes.n);
  });

  it('mismo correo normalizado en OTRO tenant → no se vincula: se crea fila propia en el tenant del alta', async () => {
    const otro = await b.fila<{ id: string }>(
      `INSERT INTO tenants (slug, nombre, status) VALUES ('otro-estudio', 'Otro', 'activo') RETURNING id`
    );
    const email = `cross-${Date.now()}@test.mx`;
    await b.fila(
      `INSERT INTO usuarios (tenant_id, email, rol, status) VALUES ($1, $2, 'miembro', 'pendiente_pago')`,
      [otro.id, email]
    );
    const a = await b.fila<{ id: string }>(
      `INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, '{"tenant_slug":"ekko"}') RETURNING id`,
      [email.toUpperCase()]
    );
    const filas = await b.filas<{ tenant_id: string; auth_id: string | null }>(
      'SELECT tenant_id, auth_id FROM usuarios WHERE lower(email) = $1 ORDER BY created_at',
      [email]
    );
    expect(filas).toHaveLength(2);
    expect(filas.find((f) => f.tenant_id === otro.id)?.auth_id).toBeNull();
    expect(filas.find((f) => f.tenant_id === b.tenantId)?.auth_id).toBe(a.id);
  });

  it('correo único por estudio sin importar mayúsculas (índice usuarios_tenant_email_lower_uniq)', async () => {
    const idx = await b.fila<{ n: number }>("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'usuarios_tenant_email_lower_uniq'");
    expect(idx.n).toBe(1);
    const m = await b.crearPersona();
    const { email } = await b.fila<{ email: string }>('SELECT email FROM usuarios WHERE id = $1', [m.id]);
    await expect(
      b.fila(`INSERT INTO usuarios (tenant_id, email, rol, status) VALUES ($1, $2, 'miembro', 'pendiente_pago')`, [b.tenantId, email.toUpperCase()])
    ).rejects.toThrow(/usuarios_tenant_email_lower_uniq/);
  });
});
