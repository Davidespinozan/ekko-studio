import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Arnés de tests CONDUCTUALES de la base: levanta un Postgres real embebido
 * (PGlite = Postgres compilado a WASM, sin Docker ni psql), le pone los stubs
 * mínimos de Supabase (`auth`, `storage`, roles) y aplica TODAS las migraciones
 * de `supabase/migrations` en orden, con sus seeds y self-tests.
 *
 * Por qué existe: los "tests de contrato" de las migraciones eran
 * `position('texto' in prosrc)` — afirman que una función CONTIENE una frase, no
 * que se COMPORTA bien. Así pasaron a la rama: reserva gratis sin membresía,
 * miembro `cancelado` tras pagar otro plan, y un trigger que le impedía reservar
 * a todo miembro con paquete (FK). Aquí se ejecutan las RPC de verdad.
 *
 * Aplicar las migraciones tarda ~10 s: una base por archivo de test
 * (`beforeAll`), y cada test crea sus propios usuarios/estudios.
 */

const MIGRACIONES = resolve(__dirname, '../../../supabase/migrations');

const STUBS_SUPABASE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  encrypted_password text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text,
  owner uuid, metadata jsonb, created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
-- Como en Supabase: los roles tienen privilegios sobre storage.*; quien decide es RLS.
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

export type Persona = { authId: string; id: string };

export class BaseDePrueba {
  private n = 0;
  constructor(readonly db: PGlite, readonly tenantId: string) {}

  async fila<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await this.db.query<T>(sql, params);
    return r.rows[0];
  }

  async filas<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  /** Alta por el mismo camino que producción: INSERT en auth.users → trigger. */
  async crearPersona(
    opts: { rol?: 'miembro' | 'recepcionista' | 'admin'; status?: string } = {}
  ): Promise<Persona> {
    const email = `p${++this.n}-${Date.now()}@test.mx`;
    const a = await this.fila<{ id: string }>(
      `INSERT INTO auth.users (email, raw_user_meta_data)
       VALUES ($1, '{"tenant_slug":"ekko","nombre":"Persona de prueba"}') RETURNING id`,
      [email]
    );
    const u = await this.fila<{ id: string }>(
      `UPDATE usuarios
       SET rol = $2, status = $3, identidad_completa = true, contrato_firmado = true
       WHERE auth_id = $1 RETURNING id`,
      [a.id, opts.rol ?? 'miembro', opts.status ?? 'activo']
    );
    return { authId: a.id, id: u.id };
  }

  async tierId(slug: string): Promise<string> {
    const t = await this.fila<{ id: string }>(
      'SELECT id FROM tiers WHERE slug = $1 AND tenant_id = $2',
      [slug, this.tenantId]
    );
    if (!t) throw new Error(`No existe el plan sembrado "${slug}"`);
    return t.id;
  }

  /** Como el webhook / recepción: por service_role (aquí, superusuario). */
  async activar(
    p: Persona,
    slug: string,
    sub: { id: string; fin?: string } | null = null
  ): Promise<Record<string, unknown>> {
    const r = await this.fila<{ r: Record<string, unknown> }>(
      'SELECT activar_membresia($1, $2, $3, $4, $5::timestamptz) AS r',
      [p.id, await this.tierId(slug), sub?.id ?? null, sub ? 'cus_test' : null, sub?.fin ?? null]
    );
    return r.r;
  }

  /** Estudio nuevo. `tiers` vacío = abierto a todos (default desde 20260821130000). */
  async crearEstudio(tiers: string[] = [], costo = 1): Promise<string> {
    const slug = `set-prueba-${++this.n}`; // no "estudio-N": choca con los sembrados (estudio-1, estudio-2)
    const r = await this.fila<{ id: string }>(
      `INSERT INTO recursos (tenant_id, nombre, slug, activo, tiers_permitidos, costo_creditos)
       VALUES ($1, $2, $2, true, $3, $4) RETURNING id`,
      [this.tenantId, slug, tiers, costo]
    );
    return r.id;
  }

  /** Mediodía del estudio, `dias` días adelante (los defaults piden 24 h de anticipación). */
  async slot(dias: number, hora = 12): Promise<string> {
    const r = await this.fila<{ t: string }>(
      `SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Mazatlan')
                + make_interval(days => $1, hours => $2)) AT TIME ZONE 'America/Mazatlan')::text AS t`,
      [dias, hora]
    );
    return r.t;
  }

  /** Ejecuta `fn` como lo haría PostgREST: rol `authenticated` + claims del JWT. */
  async como<T>(p: Persona, fn: () => Promise<T>): Promise<T> {
    await this.db.exec(
      `SELECT set_config('request.jwt.claim.sub', '${p.authId}', false);
       SELECT set_config('request.jwt.claim.role', 'authenticated', false);
       SET ROLE authenticated;`
    );
    try {
      return await fn();
    } finally {
      await this.db.exec(
        `RESET ROLE;
         SELECT set_config('request.jwt.claim.sub', '', false);
         SELECT set_config('request.jwt.claim.role', '', false);`
      );
    }
  }

  reservar(p: Persona, recursoId: string, slot: string, duracionMin = 60) {
    return this.como(p, () =>
      this.fila<{ r: { success: boolean; reserva_id: string; folio: string } }>(
        'SELECT reservar_recurso_atomic($1, $2::timestamptz, $3) AS r',
        [recursoId, slot, duracionMin]
      ).then((x) => x.r)
    );
  }

  /** Enciende/apaga `config.reserva.sets_exclusivos` del tenant de prueba. */
  async setsExclusivos(valor: boolean): Promise<void> {
    await this.db.query(
      `UPDATE tenants SET config = jsonb_set(config, '{reserva,sets_exclusivos}', $2::jsonb) WHERE id = $1`,
      [this.tenantId, JSON.stringify(valor)]
    );
  }

  ocupados(p: Persona, recursoId: string, desde: string, hasta: string) {
    return this.como(p, () =>
      this.filas<{ slot_inicio: string; slot_fin: string; mismo_set: boolean }>(
        'SELECT * FROM slots_ocupados($1, $2::timestamptz, $3::timestamptz)',
        [recursoId, desde, hasta]
      )
    );
  }

  estadoUsuario(p: Persona) {
    return this.fila<{ status: string; membresia_tier: string | null; con_activa: boolean }>(
      `SELECT status, membresia_tier, membresia_activa_id IS NOT NULL AS con_activa
       FROM usuarios WHERE id = $1`,
      [p.id]
    );
  }

  /** Flags de identidad y sanción (Fase 1 identidad). */
  identidad(p: Persona) {
    return this.fila<{ identidad_completa: boolean; sancionado_at: string | null }>(
      'SELECT identidad_completa, sancionado_at FROM usuarios WHERE id = $1',
      [p.id]
    );
  }

  async creditos(p: Persona): Promise<number | null> {
    const r = await this.fila<{ creditos_restantes: number | null }>(
      `SELECT creditos_restantes FROM membresias
       WHERE usuario_id = $1 AND status IN ('trialing','activa','past_due')
       ORDER BY created_at DESC LIMIT 1`,
      [p.id]
    );
    return r?.creditos_restantes ?? null;
  }
}

export async function levantarBase(opts: { comoLaDejaLaMigracion?: boolean } = {}): Promise<BaseDePrueba> {
  const db = new PGlite({ extensions: { btree_gist, pg_trgm, pgcrypto } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  await db.exec(STUBS_SUPABASE);

  // EKKO_DB_HASTA=20260821999999 aplica solo hasta esa migración: sirve para
  // comprobar que un test nuevo falla ANTES del fix (que muerde).
  const hasta = process.env.EKKO_DB_HASTA;
  const archivos = readdirSync(MIGRACIONES)
    .filter((f) => f.endsWith('.sql') && (!hasta || f.slice(0, 14) <= hasta))
    .sort();
  for (const f of archivos) {
    try {
      await db.exec(readFileSync(resolve(MIGRACIONES, f), 'utf8'));
    } catch (e) {
      throw new Error(`La migración ${f} no aplica sobre una base limpia: ${(e as Error).message}`);
    }
  }

  const t = await db.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'ekko'");
  const base = new BaseDePrueba(db, t.rows[0].id);
  // La migración 20260920200000 deja "un solo set a la vez" ENCENDIDO para EKKO.
  // Los tests crean un estudio por caso y reservan a la misma hora: aquí se apaga
  // para que no choquen entre sí; el test de disponibilidad lo enciende.
  if (!opts.comoLaDejaLaMigracion) await base.setsExclusivos(false);
  return base;
}
