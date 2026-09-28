import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { levantarBase, type BaseDePrueba } from './harness';

/**
 * PKG-01A — Migración 094 (`stripe_eventos_estado`) sobre PGlite con TODAS las
 * migraciones: columnas, CHECK, índice, backfill honesto y el RPC atómico
 * `claim_stripe_event` (nuevo | reclamado | duplicado | en_curso).
 *
 * Concurrencia: PGlite es mono-conexión, así que aquí se prueban las
 * transiciones y las condiciones que el RPC evalúa; la exclusión real entre dos
 * entregas simultáneas la dan INSERT … ON CONFLICT + SELECT … FOR UPDATE dentro
 * de una sola función (una transacción), semántica de PostgreSQL, no del código.
 */

const MIGRACION_094 = resolve(__dirname, '../../../supabase/migrations/20260928100000_stripe_eventos_estado.sql');
const FIRMA = 'claim_stripe_event(text,text,text,boolean,timestamptz,text,jsonb,integer)';

type Claim = { resultado: string; estado_previo: string | null; accion_previa: string | null; intentos: number };
type Fila = { id: string; estado: string; intentos: number; motivo: string | null; lease_hasta: string | null; processed_at: string | null; resumen: Record<string, unknown> | null; accion: string | null };

let b: BaseDePrueba;
let n = 0;
const nuevoId = () => `evt_test_${Date.now()}_${++n}`;

async function claim(id: string, extra: Partial<{ type: string; account: string | null; resumen: unknown; lease: number }> = {}): Promise<Claim> {
  const r = await b.fila<{ c: Claim }>(
    'SELECT claim_stripe_event($1, $2, $3, NULL, now(), $4, $5::jsonb, $6) AS c',
    [id, extra.type ?? 'invoice.paid', extra.account ?? 'acct_test', 'dahlia', JSON.stringify(extra.resumen ?? { id: 'in_1' }), extra.lease ?? 60]
  );
  return r.c;
}
const fila = (id: string) => b.fila<Fila>('SELECT * FROM stripe_webhook_events WHERE id = $1', [id]);

beforeAll(async () => {
  b = await levantarBase();
});
afterAll(async () => {
  await b.db.close();
});

describe('migración 094: esquema', () => {
  it('agrega las columnas de estado, el CHECK y el índice de atención; no crea segunda tabla', async () => {
    const cols = await b.filas<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'stripe_webhook_events'"
    );
    const nombres = cols.map((c) => c.column_name);
    for (const c of ['id', 'type', 'received_at', 'processed_at', 'estado', 'intentos', 'accion', 'motivo', 'ultimo_error', 'ultimo_intento_at', 'lease_hasta', 'stripe_account', 'livemode', 'event_created_at', 'api_version', 'resumen']) {
      expect(nombres, c).toContain(c);
    }
    const idx = await b.fila<{ n: number }>("SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'stripe_webhook_events_atencion_idx'");
    expect(idx.n).toBe(1);
    const tablas = await b.fila<{ n: number }>("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'stripe_%event%'");
    expect(tablas.n).toBe(1);
  });

  it('el CHECK rechaza un estado fuera de la máquina', async () => {
    const id = nuevoId();
    await claim(id);
    await expect(b.db.query("UPDATE stripe_webhook_events SET estado = 'terminado' WHERE id = $1", [id])).rejects.toThrow(/estado_check/);
    await expect(b.db.query('UPDATE stripe_webhook_events SET intentos = -1 WHERE id = $1', [id])).rejects.toThrow(/intentos_check/);
  });

  it('claim_stripe_event: solo service_role puede ejecutarlo', async () => {
    const p = await b.fila<{ anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT has_function_privilege('anon', '${FIRMA}', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', '${FIRMA}', 'EXECUTE') AS auth,
              has_function_privilege('service_role', '${FIRMA}', 'EXECUTE') AS svc`
    );
    expect(p).toEqual({ anon: false, auth: false, svc: true });
    const def = await b.fila<{ secdef: boolean; cfg: string[] | null }>(
      "SELECT prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE proname = 'claim_stripe_event'"
    );
    expect(def.secdef).toBe(true);
    expect(def.cfg?.join(' ')).toMatch(/search_path=public/);
  });
});

describe('claim_stripe_event: transiciones', () => {
  it('evento nuevo → en_proceso, intentos 1, lease vigente, resumen y cuenta guardados', async () => {
    const id = nuevoId();
    const c = await claim(id, { resumen: { id: 'in_9', subscription: 'sub_9' } });
    expect(c).toMatchObject({ resultado: 'nuevo', estado_previo: null, intentos: 1 });
    const f = await fila(id);
    expect(f.estado).toBe('en_proceso');
    expect(f.intentos).toBe(1);
    expect(f.processed_at).toBeNull();
    expect(new Date(f.lease_hasta!).getTime()).toBeGreaterThan(Date.now());
    expect(f.resumen).toEqual({ id: 'in_9', subscription: 'sub_9' });
  });

  it('lease vigente → en_curso (la segunda entrega NO obtiene el claim ni cambia la fila)', async () => {
    const id = nuevoId();
    await claim(id);
    const antes = await fila(id);
    const c = await claim(id);
    expect(c).toMatchObject({ resultado: 'en_curso', estado_previo: 'en_proceso', intentos: 1 });
    const despues = await fila(id);
    expect(despues).toEqual(antes);
  });

  it('procesado e ignorado → duplicado; nunca se reclaman de nuevo', async () => {
    for (const estado of ['procesado', 'ignorado']) {
      const id = nuevoId();
      await claim(id);
      await b.db.query("UPDATE stripe_webhook_events SET estado = $2, accion = 'sync', lease_hasta = NULL, processed_at = now() WHERE id = $1", [id, estado]);
      const c = await claim(id);
      expect(c).toMatchObject({ resultado: 'duplicado', estado_previo: estado, accion_previa: 'sync', intentos: 1 });
      expect((await fila(id)).estado).toBe(estado);
    }
  });

  it('lease vencido (function muerta a medias) → reclamado, intentos+1, devuelve la acción previa', async () => {
    const id = nuevoId();
    await claim(id);
    await b.db.query("UPDATE stripe_webhook_events SET lease_hasta = now() - interval '1 second', accion = 'invitados-extra' WHERE id = $1", [id]);
    const c = await claim(id);
    expect(c).toMatchObject({ resultado: 'reclamado', estado_previo: 'en_proceso', accion_previa: 'invitados-extra', intentos: 2 });
    const f = await fila(id);
    expect(f.estado).toBe('en_proceso');
    expect(f.intentos).toBe(2);
    expect(new Date(f.lease_hasta!).getTime()).toBeGreaterThan(Date.now());
  });

  it('error_reintentable → reclamado (el reintento de Stripe lo retoma)', async () => {
    const id = nuevoId();
    await claim(id);
    await b.db.query("UPDATE stripe_webhook_events SET estado = 'error_reintentable', lease_hasta = NULL, ultimo_error = 'fetch failed' WHERE id = $1", [id]);
    const c = await claim(id);
    expect(c).toMatchObject({ resultado: 'reclamado', estado_previo: 'error_reintentable', intentos: 2 });
    expect((await fila(id)).estado).toBe('en_proceso');
  });

  it('revision → reclamado (re-entrega manual desde Stripe tras corregir la causa)', async () => {
    const id = nuevoId();
    await claim(id);
    await b.db.query("UPDATE stripe_webhook_events SET estado = 'revision', lease_hasta = NULL, motivo = 'EKKO_TIER_INVALIDO' WHERE id = $1", [id]);
    const c = await claim(id);
    expect(c).toMatchObject({ resultado: 'reclamado', estado_previo: 'revision', intentos: 2 });
    expect((await fila(id)).estado).toBe('en_proceso');
  });

  it('la reclamación conserva lo ya guardado (type, cuenta, resumen) y solo rellena lo vacío', async () => {
    const id = nuevoId();
    await claim(id, { type: 'invoice.paid', account: 'acct_a', resumen: { id: 'in_1' } });
    await b.db.query("UPDATE stripe_webhook_events SET lease_hasta = now() - interval '1 second' WHERE id = $1", [id]);
    await claim(id, { type: 'otro', account: 'acct_b', resumen: { id: 'in_2' } });
    const f = await b.fila<{ type: string; stripe_account: string; resumen: unknown }>('SELECT type, stripe_account, resumen FROM stripe_webhook_events WHERE id = $1', [id]);
    expect(f).toEqual({ type: 'invoice.paid', stripe_account: 'acct_a', resumen: { id: 'in_1' } });
  });

  it('sin id → excepción (no se crea una fila anónima)', async () => {
    await expect(b.db.query("SELECT claim_stripe_event('', 'x')")).rejects.toThrow(/EKKO_EVENTO_SIN_ID/);
  });
});

describe('migración 094: backfill honesto de la historia', () => {
  it('filas con processed_at → procesado con motivo legacy_backfill_assumed_processed; sin processed_at → revision', async () => {
    // Base SOLO hasta la 093, con filas "como las dejó 20260920170000", y luego la 094.
    process.env.EKKO_DB_HASTA = '20260927999999';
    let legacy: BaseDePrueba;
    try {
      legacy = await levantarBase();
    } finally {
      delete process.env.EKKO_DB_HASTA;
    }
    try {
      const cols = await legacy.fila<{ n: number }>("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='stripe_webhook_events' AND column_name='estado'");
      expect(cols.n).toBe(0);
      await legacy.db.query(
        `INSERT INTO stripe_webhook_events (id, type, received_at, processed_at) VALUES
           ('evt_legacy_ok', 'invoice.paid', now() - interval '60 days', now() - interval '60 days'),
           ('evt_legacy_sin', 'customer.subscription.updated', now() - interval '59 days', NULL)`
      );
      await legacy.db.exec(readFileSync(MIGRACION_094, 'utf8'));
      const filas = await legacy.filas<{ id: string; estado: string; motivo: string; intentos: number; processed_at: string | null }>(
        'SELECT id, estado, motivo, intentos, processed_at FROM stripe_webhook_events ORDER BY id'
      );
      expect(filas).toEqual([
        expect.objectContaining({ id: 'evt_legacy_ok', estado: 'procesado', motivo: 'legacy_backfill_assumed_processed', intentos: 1 }),
        expect.objectContaining({ id: 'evt_legacy_sin', estado: 'revision', motivo: 'legacy_backfill_unprocessed', intentos: 1, processed_at: null })
      ]);
      // La historia no se borra ni se "observa": el processed_at original se conserva.
      expect(filas[0].processed_at).not.toBeNull();
      // Y la migración es re-aplicable (IF NOT EXISTS / OR REPLACE) sin volver a tocar el backfill.
      await legacy.db.exec(readFileSync(MIGRACION_094, 'utf8'));
      const otra = await legacy.fila<{ n: number }>("SELECT count(*)::int n FROM stripe_webhook_events WHERE motivo LIKE 'legacy_backfill%'");
      expect(otra.n).toBe(2);
    } finally {
      await legacy.db.close();
    }
  });
});
