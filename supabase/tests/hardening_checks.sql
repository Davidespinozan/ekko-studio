-- ============================================================================
-- HARDENING — checks de privilegios y contratos (2026-08-21, paridad con SALA)
-- ============================================================================
-- Cómo usar: pegar TODO en el SQL editor de Supabase (EKKO) y ejecutar. Devuelve
-- una TABLA area · caso · resultado (✅/❌). Complementa sec_fix_checks.sql y
-- schema_drift_check.sql con lo que se endureció en el Sprint 1:
--   P1  funciones de cron/keystone NO ejecutables por authenticated/anon
--   P2  tenants: columnas stripe_* solo backend; UPDATE acotado
--   P3  storage: las policies de escritura atan el objeto al tenant
--   P4  contratos: los guards clave siguen en el cuerpo de cada función
--       (si alguien recrea una función y pierde un guard, esto lo cacha)
-- ============================================================================

DROP TABLE IF EXISTS _hardening_resultado;
CREATE TEMP TABLE _hardening_resultado (
  id serial PRIMARY KEY,
  area text,
  caso text,
  resultado text
);

-- ── P1: denylist de ejecución ────────────────────────────────────────────────
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'expirar_membresias_vencidas()',
    'marcar_no_shows()',
    'generar_recordatorios_reservas()',
    'sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz)',
    'registrar_invitados_extra_pagados(uuid, integer)'
  ] LOOP
    BEGIN
      INSERT INTO _hardening_resultado (area, caso, resultado) VALUES
        ('P1', f || ' solo service_role',
         CASE WHEN NOT has_function_privilege('authenticated', f, 'EXECUTE')
                   AND NOT has_function_privilege('anon', f, 'EXECUTE')
                   AND has_function_privilege('service_role', f, 'EXECUTE')
              THEN '✅ PASS' ELSE '❌ FAIL — permisos incorrectos' END);
    EXCEPTION WHEN undefined_function THEN
      INSERT INTO _hardening_resultado (area, caso, resultado) VALUES ('P1', f, '⏭ no existe con esa firma');
    END;
  END LOOP;
END $$;

-- ── P2: tenants por columnas ─────────────────────────────────────────────────
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P2', 'anon/authenticated NO leen stripe_*',
  CASE WHEN NOT has_column_privilege('anon', 'tenants', 'stripe_account_id', 'SELECT')
            AND NOT has_column_privilege('authenticated', 'tenants', 'stripe_account_id', 'SELECT')
            AND NOT has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'SELECT')
            AND NOT has_column_privilege('authenticated', 'tenants', 'stripe_subscription_product_id', 'SELECT')
       THEN '✅ PASS' ELSE '❌ FAIL' END
UNION ALL
SELECT 'P2', 'authenticated NO actualiza stripe_*/slug/status',
  CASE WHEN NOT has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'UPDATE')
            AND NOT has_column_privilege('authenticated', 'tenants', 'slug', 'UPDATE')
            AND NOT has_column_privilege('authenticated', 'tenants', 'status', 'UPDATE')
       THEN '✅ PASS' ELSE '❌ FAIL' END
UNION ALL
SELECT 'P2', 'público sigue leyendo nombre/config/branding y admin edita config',
  CASE WHEN has_column_privilege('anon', 'tenants', 'nombre', 'SELECT')
            AND has_column_privilege('authenticated', 'tenants', 'config', 'SELECT')
            AND has_column_privilege('authenticated', 'tenants', 'branding', 'UPDATE')
       THEN '✅ PASS' ELSE '❌ FAIL' END
UNION ALL
SELECT 'P2', 'radar: ninguna columna nueva de tenants fuera de la lista conocida',
  CASE WHEN NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenants'
           AND column_name NOT IN (
             'id','slug','nombre','vertical','branding','config','dominio_principal','dominio_app',
             'status','created_at','updated_at',
             'stripe_account_id','stripe_subscription_product_id','stripe_charges_enabled','stripe_details_submitted'
           )
       ) THEN '✅ PASS' ELSE '⚠️ REVISAR — hay columnas nuevas: decidir si son públicas (GRANT) o privadas' END;

-- ── P3: storage con scope de tenant ──────────────────────────────────────────
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P3', policyname || ' ata path + tenant',
  CASE WHEN position('foldername' in coalesce(qual, with_check)) > 0
            AND position('get_my_tenant_id' in coalesce(qual, with_check)) > 0
       THEN '✅ PASS' ELSE '❌ FAIL' END
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname IN (
    'Estudios admin upload','Estudios admin update','Estudios admin delete',
    'Logos admin upload','Logos admin update','Logos admin delete',
    'avatars_admin_write','avatars_admin_update','avatars_admin_delete'
  );

INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P3', 'existen las 9 policies de escritura',
  CASE WHEN count(*) = 9 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || count(*) END
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname IN (
    'Estudios admin upload','Estudios admin update','Estudios admin delete',
    'Logos admin upload','Logos admin update','Logos admin delete',
    'avatars_admin_write','avatars_admin_update','avatars_admin_delete'
  );

-- ── P4: contratos (guards que no pueden perderse al recrear funciones) ───────
CREATE OR REPLACE FUNCTION pg_temp._fn_contiene(p_fn text, p_frag text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(position(p_frag in (
    SELECT prosrc FROM pg_proc WHERE proname = p_fn AND pronamespace = 'public'::regnamespace LIMIT 1
  )) > 0, false);
$$;

INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', fn || ' contiene ' || frag,
  CASE WHEN pg_temp._fn_contiene(fn, frag) THEN '✅ PASS' ELSE '❌ FAIL — guard perdido' END
FROM (VALUES
  ('cancelar_reserva_atomic',      'EKKO_TENANT_DIFERENTE'),
  ('check_in_atomic',              'EKKO_TENANT_DIFERENTE'),
  ('check_in_manual_atomic',       'EKKO_TENANT_DIFERENTE'),
  ('reservar_recurso_atomic',      '_recurso_permite_tier'),
  ('reservar_recurso_atomic',      'FOR UPDATE'),
  ('reservar_recurso_atomic',      'EKKO_LIMITE_DIARIO'),
  ('reservar_para_miembro_atomic', '_recurso_permite_tier'),
  ('reservar_para_miembro_atomic', 'EKKO_NO_AUTORIZADO'),
  ('marcar_no_shows',              'no_show_bloqueo_dias'),
  ('creditos_devolver_al_cancelar','cancelacion_min_horas_antes'),
  ('count_active_admins',          'get_my_tenant_id'),
  ('count_admins_activos',         'get_my_tenant_id'),
  ('count_reservas_recurso',       'get_my_tenant_id'),
  ('count_miembros_tier',          'get_my_tenant_id'),
  ('recursos_validar_tiers_permitidos', 'EKKO_TIER_PERMITIDO_INVALIDO')
) AS c(fn, frag);

INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P4', 'creditos_devolver_al_cancelar NO decide con anticipacion_min_horas',
  CASE WHEN NOT pg_temp._fn_contiene('creditos_devolver_al_cancelar', 'anticipacion_min_horas')
       THEN '✅ PASS' ELSE '❌ FAIL' END;

-- ── Resultado ────────────────────────────────────────────────────────────────
SELECT area, caso, resultado FROM _hardening_resultado ORDER BY id;
