// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarBase, type BaseDePrueba, type Persona } from './harness';

/**
 * PKG-00F · migración 20261001100000_email_resultado contra un Postgres real
 * (PGlite). Invariantes de la evidencia de correo (C03):
 *   · `aceptado` exige id del proveedor y `email_enviado_at`;
 *   · `sin_correo` / `fallo` NUNCA llevan id ni `email_enviado_at`;
 *   · solo los tres estados aprobados;
 *   · aditiva: el histórico (enviado_at con resultado NULL) sigue siendo válido
 *     y no se reinterpreta; el índice parcial previo sigue existiendo.
 */

let b: BaseDePrueba;
let miembro: Persona;

async function aviso(): Promise<string> {
  const r = await b.fila<{ id: string }>(
    `INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje)
     VALUES ($1, $2, 'reserva_confirmada', 'Reserva confirmada', 'Lunes 17:00') RETURNING id`,
    [b.tenantId, miembro.id]
  );
  return r.id;
}

async function falla(sql: string, params: unknown[]): Promise<string> {
  try {
    await b.db.query(sql, params);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeAll(async () => {
  b = await levantarBase();
  miembro = await b.crearPersona();
}, 120_000);

afterAll(async () => {
  await b.db.close();
});

describe('columnas y restricciones', () => {
  it('agrega email_resultado y email_proveedor_id, ambas text y NULLables (histórico intacto)', async () => {
    const cols = await b.filas<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'notificaciones' AND column_name IN ('email_resultado', 'email_proveedor_id', 'email_enviado_at')
       ORDER BY column_name`
    );
    expect(cols).toEqual([
      { column_name: 'email_enviado_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'email_proveedor_id', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'email_resultado', data_type: 'text', is_nullable: 'YES' }
    ]);
  });

  it('solo admite aceptado | sin_correo | fallo', async () => {
    const id = await aviso();
    for (const v of ['aceptado', 'sin_correo', 'fallo']) {
      const patch = v === 'aceptado' ? `email_resultado = 'aceptado', email_proveedor_id = 're_1', email_enviado_at = now()` : `email_resultado = '${v}', email_proveedor_id = NULL, email_enviado_at = NULL`;
      expect(await falla(`UPDATE notificaciones SET ${patch} WHERE id = $1`, [id])).toBe('');
    }
    const err = await falla(`UPDATE notificaciones SET email_resultado = 'entregado', email_proveedor_id = NULL, email_enviado_at = NULL WHERE id = $1`, [id]);
    expect(err).toMatch(/notificaciones_email_resultado_check/);
  });

  it('aceptado SIN id del proveedor o SIN email_enviado_at → rechazado (nunca éxito sin evidencia)', async () => {
    const id = await aviso();
    expect(await falla(`UPDATE notificaciones SET email_resultado = 'aceptado', email_enviado_at = now() WHERE id = $1`, [id])).toMatch(/notificaciones_email_aceptado_check/);
    expect(await falla(`UPDATE notificaciones SET email_resultado = 'aceptado', email_proveedor_id = 're_1' WHERE id = $1`, [id])).toMatch(/notificaciones_email_aceptado_check/);
    expect(await falla(`UPDATE notificaciones SET email_resultado = 'aceptado', email_proveedor_id = 're_1', email_enviado_at = now() WHERE id = $1`, [id])).toBe('');
  });

  it('fallo / sin_correo CON email_enviado_at o CON id → rechazado (un fallo no se puede disfrazar de enviado)', async () => {
    const id = await aviso();
    expect(await falla(`UPDATE notificaciones SET email_resultado = 'fallo', email_enviado_at = now() WHERE id = $1`, [id])).toMatch(/notificaciones_email_no_aceptado_check/);
    expect(await falla(`UPDATE notificaciones SET email_resultado = 'sin_correo', email_proveedor_id = 're_x' WHERE id = $1`, [id])).toMatch(/notificaciones_email_no_aceptado_check/);
    expect(await falla(`UPDATE notificaciones SET email_resultado = 'fallo' WHERE id = $1`, [id])).toBe('');
  });

  it('histórico anterior a 00F (email_enviado_at con resultado NULL) sigue siendo válido y no se reinterpreta', async () => {
    const id = await aviso();
    expect(await falla(`UPDATE notificaciones SET email_enviado_at = creada_at WHERE id = $1`, [id])).toBe('');
    const fila = await b.fila<{ email_resultado: string | null; email_proveedor_id: string | null }>(
      'SELECT email_resultado, email_proveedor_id FROM notificaciones WHERE id = $1',
      [id]
    );
    expect(fila).toEqual({ email_resultado: null, email_proveedor_id: null });
  });

  it('una fila recién creada nace pendiente: sin resultado, sin id, sin marca', async () => {
    const id = await aviso();
    const fila = await b.fila<{ email_resultado: string | null; email_proveedor_id: string | null; email_enviado_at: string | null }>(
      'SELECT email_resultado, email_proveedor_id, email_enviado_at FROM notificaciones WHERE id = $1',
      [id]
    );
    expect(fila).toEqual({ email_resultado: null, email_proveedor_id: null, email_enviado_at: null });
  });
});

describe('índice y aditividad', () => {
  it('conserva el índice parcial de pendientes (cubre el predicado del cron) y no agrega otro', async () => {
    const idx = await b.filas<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'notificaciones' AND indexname LIKE '%email%' ORDER BY 1`
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexname).toBe('notificaciones_email_pendiente_idx');
    expect(idx[0].indexdef).toMatch(/WHERE \(email_enviado_at IS NULL\)/);
  });

  it('las tres restricciones existen y nada más cambió en la tabla (sin DROP, sin UPDATE)', async () => {
    const cons = await b.filas<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'notificaciones'::regclass AND conname LIKE 'notificaciones_email%' ORDER BY 1`
    );
    expect(cons.map((c) => c.conname)).toEqual([
      'notificaciones_email_aceptado_check',
      'notificaciones_email_no_aceptado_check',
      'notificaciones_email_resultado_check'
    ]);
    const sql = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../../../supabase/migrations/20261001100000_email_resultado.sql'),
      'utf8'
    );
    const sinComentarios = sql.replace(/^\s*--.*$/gm, '');
    expect(sinComentarios).not.toMatch(/\bDROP\b/i);
    expect(sinComentarios).not.toMatch(/\bUPDATE\b/i);
    expect(sinComentarios).not.toMatch(/\bDELETE\b/i);
    expect(sinComentarios).not.toMatch(/activar_membresia|sync_membresia_stripe|claim_stripe_event|registrar_venta_mostrador/);
  });
});
