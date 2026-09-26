// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/** SALA_PARITY_AUDIT_2 §3.2 S2–S5: lo que la base impide aunque el front se salte todo. */

let b: BaseDePrueba;
beforeAll(async () => {
  b = await levantarBase();
}, 120_000);

const update = (p: Persona, sql: string, params: unknown[]) => b.como(p, () => b.db.query(sql, params));

describe('S2 — el estudio nunca se queda sin admin activo', () => {
  it('degradar o suspender al ÚNICO admin activo se rechaza, incluso por service_role', async () => {
    // El tenant sembrado no tiene admins: este es el único.
    const unico = await b.crearPersona({ rol: 'admin' });
    await expect(b.db.query("UPDATE usuarios SET rol = 'miembro' WHERE id = $1", [unico.id])).rejects.toThrow(/EKKO_ULTIMO_ADMIN/);
    await expect(b.db.query("UPDATE usuarios SET status = 'revocado' WHERE id = $1", [unico.id])).rejects.toThrow(/EKKO_ULTIMO_ADMIN/);
    await expect(b.db.query('DELETE FROM usuarios WHERE id = $1', [unico.id])).rejects.toThrow(/EKKO_ULTIMO_ADMIN/);

    // Con un segundo admin activo, sí.
    await b.crearPersona({ rol: 'admin' });
    await b.db.query("UPDATE usuarios SET status = 'revocado' WHERE id = $1", [unico.id]);
    expect((await b.estadoUsuario(unico)).status).toBe('revocado');
  });

  it('un admin activo NO puede degradarse a sí mismo si es el último (aunque sea admin)', async () => {
    const solo = await b.crearPersona({ rol: 'admin' });
    // Se revoca a los demás (permitido: queda `solo`) para que sea el último.
    await b.db.query("UPDATE usuarios SET status = 'revocado' WHERE rol = 'admin' AND status = 'activo' AND id <> $1", [solo.id]);
    await expect(update(solo, "UPDATE usuarios SET rol = 'recepcionista' WHERE id = $1", [solo.id])).rejects.toThrow(/EKKO_ULTIMO_ADMIN/);
  });
});

describe('S4 — un miembro no toca sus columnas privilegiadas', () => {
  it('nombre y teléfono sí; email, notas_admin, membresia_activa_id, auth_id e invitado no', async () => {
    const m = await b.crearPersona();
    await update(m, "UPDATE usuarios SET nombre = 'Ana', telefono = '6691234567' WHERE id = $1", [m.id]);
    for (const set of ["email = 'otro@e.mx'", "notas_admin = 'VIP'", "membresia_activa_id = gen_random_uuid()", "invitado = true", "status = 'suspendido'", "membresia_tier = 'premium'"]) {
      await expect(update(m, `UPDATE usuarios SET ${set} WHERE id = $1`, [m.id])).rejects.toThrow(/EKKO_NO_AUTORIZADO/);
    }
    const fila = await b.fila<{ nombre: string; email: string }>('SELECT nombre, email FROM usuarios WHERE id = $1', [m.id]);
    expect(fila.nombre).toBe('Ana');
    expect(fila.email).toMatch(/@test\.mx$/);
  });

  it('un admin activo sí cambia el status de un miembro', async () => {
    await b.crearPersona({ rol: 'admin' });
    const admin = await b.crearPersona({ rol: 'admin' });
    const m = await b.crearPersona();
    await update(admin, "UPDATE usuarios SET status = 'suspendido' WHERE id = $1", [m.id]);
    expect((await b.estadoUsuario(m)).status).toBe('suspendido');
  });
});

describe('S5 — ledgers inmutables', () => {
  it('membresia_movimientos: ni UPDATE ni DELETE, ni con service_role', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const mov = await b.fila<{ id: string }>("SELECT id FROM membresia_movimientos WHERE usuario_id = $1 AND tipo = 'alta'", [m.id]);
    await expect(b.db.query('UPDATE membresia_movimientos SET delta = 999 WHERE id = $1', [mov.id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
    await expect(b.db.query('DELETE FROM membresia_movimientos WHERE id = $1', [mov.id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
  });

  it('…pero el CASCADE al borrar la membresía y el SET NULL al borrar una reserva siguen funcionando', async () => {
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(3));
    const mov = await b.fila<{ id: string }>("SELECT id FROM membresia_movimientos WHERE reserva_id = $1", [r.reserva_id]);
    await b.db.query('DELETE FROM reservas WHERE id = $1', [r.reserva_id]);
    expect((await b.fila<{ reserva_id: string | null }>('SELECT reserva_id FROM membresia_movimientos WHERE id = $1', [mov.id])).reserva_id).toBeNull();

    await b.db.query('DELETE FROM membresias WHERE usuario_id = $1', [m.id]);
    expect(await b.filas('SELECT 1 FROM membresia_movimientos WHERE usuario_id = $1', [m.id])).toHaveLength(0);
  });

  it('audit_log: ni UPDATE ni DELETE, nunca', async () => {
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    const m = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    await b.como(recep, () => b.fila('SELECT staff_ajustar_creditos($1, 1, $2)', [m.id, 'cortesía del estudio']));
    const a = await b.fila<{ id: string }>('SELECT id FROM audit_log WHERE target_id = $1', [m.id]);
    await expect(b.db.query("UPDATE audit_log SET motivo = 'otro' WHERE id = $1", [a.id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
    await expect(b.db.query('DELETE FROM audit_log WHERE id = $1', [a.id])).rejects.toThrow(/EKKO_LEDGER_INMUTABLE/);
  });
});

describe('S3 — un miembro no consulta el estado de membresía de otro', () => {
  it('_estado_membresia_checkin ya no es ejecutable por authenticated; el check-in (DEFINER) sigue funcionando', async () => {
    const m = await b.crearPersona();
    const otro = await b.crearPersona();
    await b.activar(m, 'pro-pack');
    const r = await b.reservar(m, await b.crearEstudio(), await b.slot(4));
    await expect(b.como(otro, () => b.fila('SELECT _estado_membresia_checkin($1, $2)', [m.id, r.reserva_id]))).rejects.toThrow(/permission denied/);
    const recep = await b.crearPersona({ rol: 'recepcionista' });
    // La sesión es en 4 días: el error debe ser de VENTANA (demasiado temprano), no de permisos.
    await expect(b.como(recep, () => b.fila('SELECT check_in_manual_atomic($1, $2)', [r.reserva_id, 'x']))).rejects.toThrow(/EKKO_DEMASIADO_TEMPRANO/);
  });
});
