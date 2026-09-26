// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { levantarBase, type BaseDePrueba } from './harness';

/**
 * Ensayo de la ventana de producción (Fase 1 identidad, 2026-09-25): las 92
 * migraciones aplican en orden sobre una base limpia sin intervención, y el
 * esquema final cumple las postcondiciones que el código desplegado asume.
 * Si una migración nueva rompe alguna, este test lo dice antes que producción.
 */

let b: BaseDePrueba;
beforeAll(async () => {
  b = await levantarBase({ comoLaDejaLaMigracion: true });
}, 120_000);

const existeFn = (firma: string) =>
  b.fila<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $1`,
    [firma]
  ).then((r) => r.n);
const columna = (tabla: string, col: string) =>
  b.fila<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [tabla, col]
  ).then((r) => r.n === 1);
const trigger = (tabla: string, nombre: string) =>
  b.fila<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = $1 AND t.tgname = $2`,
    [tabla, nombre]
  ).then((r) => r.n === 1);
const indice = (nombre: string) =>
  b.fila<{ n: number }>("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [nombre]).then((r) => r.n === 1);
const policy = (tabla: string, nombre: string) =>
  b.fila<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2", [tabla, nombre]).then((r) => r.n === 1);
const cuerpo = (fn: string) => b.fila<{ src: string }>('SELECT prosrc AS src FROM pg_proc WHERE proname = $1', [fn]).then((r) => r.src);
const ejecutable = (firma: string, rol: string) =>
  b.fila<{ ok: boolean }>(
    `SELECT has_function_privilege($2, p.oid, 'EXECUTE') AS ok FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $1`,
    [firma, rol]
  ).then((r) => r.ok);

describe('ensayo: 92 migraciones en orden sobre base limpia', () => {
  it('el repo tiene 92 migraciones y todas aplicaron (levantarBase no lanzó)', () => {
    const archivos = readdirSync(resolve(__dirname, '../../../supabase/migrations')).filter((f) => f.endsWith('.sql'));
    expect(archivos.length).toBe(92);
  });

  it('identidad: índice único de correo normalizado por estudio', async () => {
    expect(await indice('usuarios_tenant_email_lower_uniq')).toBe(true);
  });

  it('identidad: handle_new_auth_user final (vincula, ambigüedad, correo inválido, normaliza)', async () => {
    const src = await cuerpo('handle_new_auth_user');
    expect(src).toContain('EKKO_IDENTIDAD_AMBIGUA');
    expect(src).toContain('EKKO_EMAIL_INVALIDO');
    expect(src).toContain('lower(trim(NEW.email))');
    expect(src).not.toContain('DO NOTHING');
  });

  it('membresía: firma nueva de activar_membresia con defaults; la vieja de 5 argumentos ya no existe', async () => {
    expect(await existeFn('activar_membresia(p_usuario_id uuid, p_tier_id uuid, p_stripe_subscription_id text, p_stripe_customer_id text, p_periodo_fin timestamp with time zone, p_referencia text, p_confirmar_perdida boolean)')).toBe(1);
    expect(await existeFn('activar_membresia(p_usuario_id uuid, p_tier_id uuid, p_stripe_subscription_id text, p_stripe_customer_id text, p_periodo_fin timestamp with time zone)')).toBe(0);
    // Un llamador VIEJO (5 parámetros nombrados) sigue resolviendo gracias a los defaults.
    const r = await b.fila<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p WHERE p.proname = 'activar_membresia' AND p.pronargdefaults >= 2`
    );
    expect(r.n).toBe(1);
  });

  it('sanción e identidad: columnas, triggers y protección de columnas', async () => {
    expect(await columna('usuarios', 'sancionado_at')).toBe(true);
    expect(await columna('usuarios', 'sancion_motivo')).toBe(true);
    expect(await trigger('usuarios', 'trg_sancion_manda')).toBe(true);
    expect(await trigger('usuarios', 'trg_identidad_por_avatar')).toBe(true);
    expect(await trigger('usuarios_datos_privados', 'trg_dp_recalcular_identidad')).toBe(true);
    expect(await trigger('usuarios', 'trg_no_borrar_ultimo_admin')).toBe(true);
    const prot = await cuerpo('proteger_columnas_privilegiadas_usuarios');
    for (const col of ['avatar_url', 'contrato_firmado_at', 'sancionado_at', 'sancion_motivo', 'email', 'auth_id', 'membresia_activa_id', 'notas_admin']) {
      expect(prot).toContain(`NEW.${col}`);
    }
    expect(prot).toContain('EKKO_ULTIMO_ADMIN');
  });

  it('RLS, policies y grants clave', async () => {
    expect(await policy('membresias', 'membresias_read_staff')).toBe(true);
    expect(await policy('material_sesion', 'material_read_self')).toBe(true);
    expect(await policy('material_sesion', 'material_read_staff')).toBe(true);
    expect(await ejecutable('expirar_membresias_vencidas()', 'authenticated')).toBe(false);
    expect(await ejecutable('_estado_membresia_checkin(p_usuario_id uuid, p_reserva_id uuid)', 'authenticated')).toBe(false);
    expect(await ejecutable('slots_ocupados(p_recurso_id uuid, p_desde timestamp with time zone, p_hasta timestamp with time zone)', 'authenticated')).toBe(true);
    const isAdmin = await cuerpo('is_admin');
    expect(isAdmin).toContain('activo');
    const ledger = await trigger('membresia_movimientos', 'trg_ledger_inmutable');
    expect(ledger).toBe(true);
  });

  it('crons y avisos: columnas y funciones que usan cron-email, cron-push, cron-material-vencido, no-show y vencimientos', async () => {
    expect(await columna('notificaciones', 'push_enviado_at')).toBe(true);
    expect(await columna('notificaciones', 'email_enviado_at')).toBe(true);
    expect(await columna('stripe_webhook_events', 'processed_at')).toBe(true);
    expect(await columna('membresias', 'aviso_vencimiento_at')).toBe(true);
    expect(await existeFn('material_vencido_por_borrar(p_limite integer)')).toBe(1);
    expect(await existeFn('marcar_no_shows()')).toBe(1);
    expect(await existeFn('avisar_membresias_por_vencer(p_dias integer)')).toBe(1);
    expect(await existeFn('generar_felicitaciones_cumpleanos()')).toBe(1);
    expect(await indice('reservas_recordatorio_pendiente_idx')).toBe(true);
  });

  it('material, sets exclusivos, disponibilidad y planes en venta', async () => {
    expect(await columna('material_sesion', 'storage_path')).toBe(true);
    expect(await columna('tiers', 'en_venta')).toBe(true);
    expect(await columna('membresias', 'referencia_pago')).toBe(true);
    expect(await columna('membresias', 'pausada_at')).toBe(true);
    expect(await trigger('reservas', 'trg_un_set_a_la_vez')).toBe(true);
    const cfg = await b.fila<{ v: string }>("SELECT config->'reserva'->>'sets_exclusivos' AS v FROM tenants WHERE slug = 'ekko'");
    expect(cfg.v).toBe('true');
    const bucket = await b.fila<{ n: number }>("SELECT count(*)::int AS n FROM storage.buckets WHERE id = 'material'");
    expect(bucket.n).toBe(1);
  });

  it('el CHECK de membresias incluye pausada y los CHECK de tiers quedaron validados', async () => {
    const chk = await b.fila<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'membresias_status_check'");
    expect(chk.def).toContain('pausada');
    const validados = await b.filas<{ conname: string; convalidated: boolean }>(
      "SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('tiers_precio_no_negativo','tiers_duracion_positiva','tiers_paquete_con_sesiones','tiers_hibrido_con_vigencia','membresias_creditos_no_negativos')"
    );
    expect(validados).toHaveLength(5);
    expect(validados.every((c) => c.convalidated)).toBe(true);
  });
});
