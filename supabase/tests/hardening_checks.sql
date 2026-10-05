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
    -- PKG-01H: reemplazan a registrar_invitados_extra_pagados (ver abajo).
    'aplicar_invitados_extra_pago(text, text, uuid, text, uuid, uuid, integer, integer, integer, text, timestamptz, uuid)',
    'registrar_ficha_invitado(uuid, uuid, text, text)'
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

-- PKG-01H: la firma vieja (sumaba sin llave por PaymentIntent) no la ejecuta
-- NADIE de la app, ni service_role. Existe (sin DROP) pero está revocada.
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P1', 'registrar_invitados_extra_pagados(uuid, integer) revocada para todos',
  CASE WHEN NOT has_function_privilege('authenticated', 'registrar_invitados_extra_pagados(uuid, integer)', 'EXECUTE')
            AND NOT has_function_privilege('anon', 'registrar_invitados_extra_pagados(uuid, integer)', 'EXECUTE')
            AND NOT has_function_privilege('service_role', 'registrar_invitados_extra_pagados(uuid, integer)', 'EXECUTE')
       THEN '✅ PASS' ELSE '❌ FAIL — la firma vieja sigue ejecutable' END;

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
             'stripe_account_id','stripe_subscription_product_id','stripe_charges_enabled','stripe_details_submitted',
             'stripe_desconectado_at' -- PKG-01G: privada (solo service_role), como el resto de stripe_*
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
  ('creditos_devolver_al_cancelar','cancelacion_tardia'),
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

-- ── P5: frontera por REST (PKG-02C) ──────────────────────────────────────────
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'ninguna policy decide por rol crudo sin estado activo',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
         AND (coalesce(qual,'')||coalesce(with_check,'')) ~ 'usuarios\.rol'
         AND (coalesce(qual,'')||coalesce(with_check,'')) !~ 'status')
       THEN '✅ PASS' ELSE '❌ FAIL — policy con rol sin status' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'ninguna policy UPDATE/ALL sin WITH CHECK',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND cmd IN ('UPDATE','ALL') AND with_check IS NULL)
       THEN '✅ PASS' ELSE '❌ FAIL — UPDATE sin WITH CHECK' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'anon sin INSERT/UPDATE/DELETE/TRUNCATE en public',
  CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
         WHERE table_schema='public' AND grantee='anon' AND privilege_type <> 'SELECT')
       THEN '✅ PASS' ELSE '❌ FAIL — anon con escritura' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'anon sin EXECUTE en funciones de aplicación',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.objid=p.oid AND d.deptype='e'))
       THEN '✅ PASS' ELSE '❌ FAIL — anon ejecuta funciones' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'authenticated sin DML donde ninguna policy escribe, y sin TRUNCATE',
  CASE WHEN NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
         WHERE g.table_schema='public' AND g.grantee='authenticated'
           AND (g.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER')
                OR (g.privilege_type IN ('INSERT','UPDATE','DELETE')
                    AND g.table_name NOT IN (SELECT tablename FROM pg_policies WHERE schemaname='public' AND cmd<>'SELECT'))))
       THEN '✅ PASS' ELSE '❌ FAIL — grant sin policy' END;
INSERT INTO _hardening_resultado (area, caso, resultado)
SELECT 'P5', 'gate cambiar_password: trigger en auth.users y frontera de avisos presentes',
  CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_password_changed')
         AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notificaciones_frontera_cliente')
         AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_notas_miembro_autor_servidor')
       THEN '✅ PASS' ELSE '❌ FAIL — falta trigger' END;

-- ── Resultado ────────────────────────────────────────────────────────────────
SELECT area, caso, resultado FROM _hardening_resultado ORDER BY id;
