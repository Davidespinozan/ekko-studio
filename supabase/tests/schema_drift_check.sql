-- ============================================================================
-- SCHEMA DRIFT CHECK — estado REAL del schema de EKKO vs. lo que las
-- migraciones del repo deberían haber creado
-- ============================================================================
-- Por qué existe: las migraciones se aplican a mano en el editor de Supabase,
-- así que la tabla de registro de migraciones NO es confiable. Este script
-- verifica el estado REAL del schema, objeto por objeto.
--
-- Cómo usar: pegá TODO este archivo en el SQL editor de Supabase (EKKO) y
-- ejecutá. Es 100% READ-ONLY — no crea, modifica ni borra nada del schema
-- (solo una TEMP TABLE que vive en la sesión).
--
-- Resultado: DOS grids al final —
--   1. Todos los checks (bloque · migración · objeto · resultado)
--   2. Solo los ❌/⚠️ — lo que hay que aplicar.
--
-- Leyenda: ✅ PASS · ❌ FALTA/DRIFT (aplicar la migración) · ⚠️ versión vieja.
-- La columna `migracion` dice de qué archivo de supabase/migrations/ viene
-- cada objeto — si algo falla, esa es la migración a aplicar.
-- ============================================================================

DROP TABLE IF EXISTS _schema_check;
CREATE TEMP TABLE _schema_check (
  id serial PRIMARY KEY,
  bloque text,
  migracion text,
  objeto text,
  resultado text
);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 1 — Tablas base + Row Level Security
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('1 · Tablas', '100100_tenants', 'tabla tenants + RLS',
 CASE WHEN to_regclass('public.tenants') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='tenants' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', '100200_usuarios', 'tabla usuarios + RLS',
 CASE WHEN to_regclass('public.usuarios') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='usuarios' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', '100300_recursos', 'tabla recursos + RLS',
 CASE WHEN to_regclass('public.recursos') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='recursos' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', '100400_membresias', 'tabla membresias + RLS',
 CASE WHEN to_regclass('public.membresias') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='membresias' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', '100500_reservas', 'tabla reservas + RLS',
 CASE WHEN to_regclass('public.reservas') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='reservas' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', '100600_pagos', 'tabla payment_events + RLS',
 CASE WHEN to_regclass('public.payment_events') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='payment_events' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', '17600000_cancelar_reservas', 'tabla notificaciones + RLS',
 CASE WHEN to_regclass('public.notificaciones') IS NULL THEN '❌ FALTA — tabla no existe'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='notificaciones' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END),
('1 · Tablas', 'SEC-FIX 21100000 (H1)', 'tabla usuarios_datos_privados + RLS',
 CASE WHEN to_regclass('public.usuarios_datos_privados') IS NULL THEN '❌ FALTA — SEC-FIX H1 no aplicada'
      WHEN EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='usuarios_datos_privados' AND c.relrowsecurity) THEN '✅ PASS'
      ELSE '⚠️ tabla existe pero SIN RLS' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 2 — Extensiones
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('2 · Extensiones', '100000_extensions', 'pgcrypto',
 CASE WHEN EXISTS(SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN '✅ PASS' ELSE '❌ FALTA' END),
('2 · Extensiones', '100000_extensions', 'pg_trgm',
 CASE WHEN EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') THEN '✅ PASS' ELSE '❌ FALTA' END),
('2 · Extensiones', '100000_extensions', 'btree_gist',
 CASE WHEN EXISTS(SELECT 1 FROM pg_extension WHERE extname='btree_gist') THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 3 — Funciones helper
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('3 · Helpers', '100700_helper_functions', 'get_my_user_id()',
 CASE WHEN to_regprocedure('public.get_my_user_id()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '100700_helper_functions', 'get_my_tenant_id()',
 CASE WHEN to_regprocedure('public.get_my_tenant_id()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '100700_helper_functions', 'get_my_rol()',
 CASE WHEN to_regprocedure('public.get_my_rol()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '100700_helper_functions', 'is_admin()',
 CASE WHEN to_regprocedure('public.is_admin()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '100700_helper_functions', 'is_recepcionista()',
 CASE WHEN to_regprocedure('public.is_recepcionista()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '100700_helper_functions', 'set_updated_at()',
 CASE WHEN to_regprocedure('public.set_updated_at()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '101000_trigger_signup', 'handle_new_auth_user()',
 CASE WHEN to_regprocedure('public.handle_new_auth_user()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '14160000_reglas_operativas', 'max_invitados_por_tier(text)',
 CASE WHEN to_regprocedure('public.max_invitados_por_tier(text)') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '14130000_admin_user_mgmt', 'count_admins_activos(uuid)',
 CASE WHEN to_regprocedure('public.count_admins_activos(uuid)') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '17400000_hard_delete_guards', 'count_active_admins(uuid)',
 CASE WHEN to_regprocedure('public.count_active_admins(uuid)') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '17400000_hard_delete_guards', 'count_reservas_recurso(uuid)',
 CASE WHEN to_regprocedure('public.count_reservas_recurso(uuid)') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END),
('3 · Helpers', '17400000_hard_delete_guards', 'count_miembros_tier(uuid)',
 CASE WHEN to_regprocedure('public.count_miembros_tier(uuid)') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 4 — RPCs atómicos core (con marcador de versión)
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('4 · RPCs core', 'LOGIC-FIX 22100000 (L-01)', 'reservar_recurso_atomic — anclado a America/Mazatlan',
 CASE WHEN to_regprocedure('public.reservar_recurso_atomic(uuid,timestamptz,integer,integer,text)') IS NULL
        THEN '❌ FALTA — la función no existe'
      WHEN pg_get_functiondef(to_regprocedure('public.reservar_recurso_atomic(uuid,timestamptz,integer,integer,text)')) LIKE '%America/Mazatlan%'
        THEN '✅ PASS'
      ELSE '⚠️ VERSIÓN VIEJA — existe pero LOGIC-FIX (L-01) no aplicada' END),
('4 · RPCs core', 'RP-1 20100000', 'reservar_para_miembro_atomic — existe',
 CASE WHEN to_regprocedure('public.reservar_para_miembro_atomic(uuid,uuid,timestamptz,integer,integer,text)') IS NOT NULL
        THEN '✅ PASS' ELSE '❌ FALTA — RP-1 no aplicada' END),
('4 · RPCs core', 'SEC-FIX 21100000 (H3)', 'cancelar_reserva_atomic — valida tenant',
 CASE WHEN to_regprocedure('public.cancelar_reserva_atomic(uuid,text)') IS NULL
        THEN '❌ FALTA — la función no existe (RP-1 / 17600000 no aplicadas)'
      WHEN pg_get_functiondef(to_regprocedure('public.cancelar_reserva_atomic(uuid,text)')) LIKE '%EKKO_TENANT_DIFERENTE%'
        THEN '✅ PASS'
      ELSE '⚠️ VERSIÓN VIEJA — existe pero SEC-FIX (H3) no aplicada' END),
('4 · RPCs core', 'LOGIC-FIX 22100000 (L-02)', 'check_in_atomic — rechaza estados no-confirmada',
 CASE WHEN to_regprocedure('public.check_in_atomic(uuid)') IS NULL
        THEN '❌ FALTA — la función no existe'
      WHEN pg_get_functiondef(to_regprocedure('public.check_in_atomic(uuid)')) LIKE '%EKKO_RESERVA_NO_CHECKINEABLE%'
        THEN '✅ PASS'
      ELSE '⚠️ VERSIÓN VIEJA — existe pero LOGIC-FIX (L-02) no aplicada' END),
('4 · RPCs core', 'LOGIC-FIX 22100000 (L-02)', 'check_in_manual_atomic — rechaza estados no-confirmada',
 CASE WHEN to_regprocedure('public.check_in_manual_atomic(uuid,text)') IS NULL
        THEN '❌ FALTA — la función no existe'
      WHEN pg_get_functiondef(to_regprocedure('public.check_in_manual_atomic(uuid,text)')) LIKE '%EKKO_RESERVA_NO_CHECKINEABLE%'
        THEN '✅ PASS'
      ELSE '⚠️ VERSIÓN VIEJA — existe pero LOGIC-FIX (L-02) no aplicada' END),
('4 · RPCs core', '14160000 / 17000001', 'marcar_no_shows() — existe',
 CASE WHEN to_regprocedure('public.marcar_no_shows()') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 5 — CHECK constraints de `status`
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('5 · CHECK status', 'RP-1 20100000 (sección 0)', 'reservas_status_check admite ''cancelada_admin''',
 CASE WHEN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE c.conname='reservas_status_check' AND t.relname='reservas') IS NULL
        THEN '❌ FALTA — el constraint no existe'
      WHEN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE c.conname='reservas_status_check' AND t.relname='reservas') LIKE '%cancelada_admin%'
        THEN '✅ PASS'
      ELSE '❌ DRIFT — el CHECK NO admite cancelada_admin → RP-1 no aplicada (cancelar/reprogramar FALLAN)' END),
('5 · CHECK status', 'LOGIC-FIX 22100000 (L-03)', 'usuarios_status_check admite ''revocado''',
 CASE WHEN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE c.conname='usuarios_status_check' AND t.relname='usuarios') IS NULL
        THEN '❌ FALTA — el constraint no existe'
      WHEN (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
            WHERE c.conname='usuarios_status_check' AND t.relname='usuarios') LIKE '%revocado%'
        THEN '✅ PASS'
      ELSE '❌ DRIFT — el CHECK NO admite revocado → LOGIC-FIX (L-03) no aplicada (revocar staff FALLA)' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 6 — Triggers
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('6 · Triggers', '101000_trigger_signup', 'on_auth_user_created (alta de usuarios)',
 CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='on_auth_user_created' AND NOT tgisinternal) THEN '✅ PASS' ELSE '❌ FALTA' END),
('6 · Triggers', 'SEC-FIX 21100000 (C2)', 'trg_proteger_columnas_usuarios (anti-escalación)',
 CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_proteger_columnas_usuarios' AND NOT tgisinternal) THEN '✅ PASS' ELSE '❌ FALTA — SEC-FIX C2 no aplicada' END),
('6 · Triggers', '100200_usuarios', 'usuarios_set_updated_at',
 CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='usuarios_set_updated_at' AND NOT tgisinternal) THEN '✅ PASS' ELSE '❌ FALTA' END),
('6 · Triggers', '100500_reservas', 'reservas_set_updated_at',
 CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='reservas_set_updated_at' AND NOT tgisinternal) THEN '✅ PASS' ELSE '❌ FALTA' END),
('6 · Triggers', 'SEC-FIX 21100000 (H1)', 'usuarios_datos_privados_set_updated_at',
 CASE WHEN EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='usuarios_datos_privados_set_updated_at' AND NOT tgisinternal) THEN '✅ PASS' ELSE '❌ FALTA — SEC-FIX H1 no aplicada' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 7 — Columnas agregadas / movidas
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('7 · Columnas', '14150000_perfil_extendido', 'usuarios.notas_admin existe',
 CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usuarios' AND column_name='notas_admin') THEN '✅ PASS' ELSE '❌ FALTA — perfil_extendido no aplicada' END),
('7 · Columnas', 'SEC-FIX 21100000 (H1)', 'usuarios.ob_data NO debe existir (movida)',
 CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usuarios' AND column_name='ob_data') THEN '✅ PASS' ELSE '❌ DRIFT — ob_data sigue en usuarios (SEC-FIX H1 no aplicada)' END),
('7 · Columnas', 'SEC-FIX 21100000 (H1)', 'usuarios.stripe_customer_id NO debe existir (movida)',
 CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usuarios' AND column_name='stripe_customer_id') THEN '✅ PASS' ELSE '❌ DRIFT — stripe_customer_id sigue en usuarios (SEC-FIX H1 no aplicada)' END),
('7 · Columnas', '14140000_check_in_method', 'reservas.check_in_method existe',
 CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservas' AND column_name='check_in_method') THEN '✅ PASS' ELSE '❌ FALTA' END),
('7 · Columnas', '17600000_cancelar_reservas', 'reservas.cancelada_por existe',
 CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservas' AND column_name='cancelada_por') THEN '✅ PASS' ELSE '❌ FALTA — 17600000 no aplicada' END),
('7 · Columnas', '17600000_cancelar_reservas', 'reservas.cancelacion_notificada_at existe',
 CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='reservas' AND column_name='cancelacion_notificada_at') THEN '✅ PASS' ELSE '❌ FALTA — 17600000 no aplicada' END),
('7 · Columnas', '15180000_recursos_metadata', 'recursos.foto_url existe',
 CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recursos' AND column_name='foto_url') THEN '✅ PASS' ELSE '❌ FALTA — recursos_metadata no aplicada' END),
('7 · Columnas', '100300_recursos', 'recursos.horarios existe (núcleo de reservas)',
 CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='recursos' AND column_name='horarios') THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 8 — usuarios_datos_privados: columnas + policies (SEC-FIX H1)
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('8 · datos_privados', 'SEC-FIX 21100000 (H1)', 'columnas usuario_id / tenant_id / stripe_customer_id / ob_data',
 CASE WHEN (SELECT count(*) FROM information_schema.columns
            WHERE table_schema='public' AND table_name='usuarios_datos_privados'
              AND column_name IN ('usuario_id','tenant_id','stripe_customer_id','ob_data')) = 4
        THEN '✅ PASS' ELSE '❌ FALTA — la tabla no tiene las 4 columnas (SEC-FIX H1 no aplicada)' END),
('8 · datos_privados', 'SEC-FIX 21100000 (H1)', 'policy udp_select_self (dueño lee lo suyo)',
 CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='usuarios_datos_privados' AND policyname='udp_select_self') THEN '✅ PASS' ELSE '❌ FALTA' END),
('8 · datos_privados', 'SEC-FIX 21100000 (H1)', 'policy udp_admin_all (admin del tenant)',
 CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='usuarios_datos_privados' AND policyname='udp_admin_all') THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 9 — Funciones dev: NO deben existir
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('9 · Limpieza dev', 'SEC-FIX 21100000 (C3)', 'dev_activar_miembro NO existe',
 CASE WHEN to_regprocedure('public.dev_activar_miembro(text,text)') IS NULL THEN '✅ PASS' ELSE '❌ DRIFT — sigue viva (SEC-FIX C3 no aplicada)' END),
('9 · Limpieza dev', '14130000 / SEC-CLEANUP', 'dev_crear_recepcionista NO existe',
 CASE WHEN to_regprocedure('public.dev_crear_recepcionista(text,text)') IS NULL THEN '✅ PASS' ELSE '❌ DRIFT — sigue viva' END),
('9 · Limpieza dev', 'SEC-CLEANUP 20110000', 'NINGUNA función dev_* en public',
 CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname LIKE 'dev\_%') = 0
        THEN '✅ PASS' ELSE '❌ DRIFT — quedan funciones dev_*' END),
('9 · Limpieza dev', 'SEC-CLEANUP 20110000', 'generar_clases_recurrentes NO existe',
 CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='generar_clases_recurrentes') = 0
        THEN '✅ PASS' ELSE '❌ DRIFT — RPC fantasma sigue viva (SEC-CLEANUP no aplicada)' END),
('9 · Limpieza dev', '17000001_fix_reglas', 'reservar_recurso_atomic 4-param (legacy) NO existe',
 CASE WHEN to_regprocedure('public.reservar_recurso_atomic(uuid,timestamptz,integer,text)') IS NULL THEN '✅ PASS' ELSE '⚠️ overload legacy 4-param presente' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 10 — Storage buckets + policies
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('10 · Storage', '14150000_perfil_extendido', 'bucket avatars',
 CASE WHEN EXISTS(SELECT 1 FROM storage.buckets WHERE id='avatars') THEN '✅ PASS' ELSE '❌ FALTA' END),
('10 · Storage', '17100000_estudios_bucket', 'bucket estudios',
 CASE WHEN EXISTS(SELECT 1 FROM storage.buckets WHERE id='estudios') THEN '✅ PASS' ELSE '❌ FALTA' END),
('10 · Storage', '17200000_landing_cms', 'bucket logos',
 CASE WHEN EXISTS(SELECT 1 FROM storage.buckets WHERE id='logos') THEN '✅ PASS' ELSE '❌ FALTA' END),
('10 · Storage', '14150000_perfil_extendido', 'policy avatars_admin_write',
 CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='avatars_admin_write') THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 11 — Grants y policies RLS sensibles
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('11 · Grants/RLS', 'SEC-FIX 21100000 (H5)', 'marcar_no_shows: solo service_role lo ejecuta',
 CASE WHEN to_regprocedure('public.marcar_no_shows()') IS NULL THEN '❌ FALTA — la función no existe'
      WHEN NOT has_function_privilege('authenticated','public.marcar_no_shows()','EXECUTE')
           AND has_function_privilege('service_role','public.marcar_no_shows()','EXECUTE') THEN '✅ PASS'
      ELSE '❌ DRIFT — authenticated todavía puede ejecutarla (SEC-FIX H5 no aplicada)' END),
('11 · Grants/RLS', '100800_rls_policies', 'usuarios: policies read_self / read_admin / update_self / update_admin',
 CASE WHEN (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='usuarios'
            AND policyname IN ('usuarios_read_self','usuarios_read_admin','usuarios_update_self','usuarios_update_admin')) = 4
        THEN '✅ PASS' ELSE '❌ FALTA — rls_policies no aplicada (' ||
            (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='usuarios'
             AND policyname IN ('usuarios_read_self','usuarios_read_admin','usuarios_update_self','usuarios_update_admin'))::text || ' de 4)' END),
('11 · Grants/RLS', '100800_rls_policies', 'reservas: policies read_self / read_admin / admin_all',
 CASE WHEN (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='reservas'
            AND policyname IN ('reservas_read_self','reservas_read_admin','reservas_admin_all')) = 3
        THEN '✅ PASS' ELSE '❌ FALTA' END),
('11 · Grants/RLS', '100800_rls_policies', 'membresias: policy membresias_admin_all',
 CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='membresias' AND policyname='membresias_admin_all') THEN '✅ PASS' ELSE '❌ FALTA' END),
('11 · Grants/RLS', '100800_rls_policies', 'payment_events: policy payment_events_admin_read',
 CASE WHEN EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payment_events' AND policyname='payment_events_admin_read') THEN '✅ PASS' ELSE '❌ FALTA' END),
('11 · Grants/RLS', '17600000_cancelar_reservas', 'notificaciones: 3 policies (lee/marca/admin crea)',
 CASE WHEN (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='notificaciones') >= 3
        THEN '✅ PASS' ELSE '❌ FALTA — 17600000 no aplicada' END);


-- ////////////////////////////////////////////////////////////////////////////
-- BLOQUE 12 — Índices / objetos varios
-- ////////////////////////////////////////////////////////////////////////////
INSERT INTO _schema_check (bloque, migracion, objeto, resultado) VALUES
('12 · Índices', '100500_reservas', 'reservas_unique_slot_per_recurso (anti doble-reserva)',
 CASE WHEN EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='reservas_unique_slot_per_recurso') THEN '✅ PASS' ELSE '❌ FALTA' END),
('12 · Índices', '100500_reservas', 'secuencia reservas_folio_seq',
 CASE WHEN to_regclass('public.reservas_folio_seq') IS NOT NULL THEN '✅ PASS' ELSE '❌ FALTA' END);


-- ////////////////////////////////////////////////////////////////////////////
-- RESULTADO 1 — todos los checks
-- ////////////////////////////////////////////////////////////////////////////
SELECT bloque, migracion, objeto, resultado
FROM _schema_check
ORDER BY id;


-- ////////////////////////////////////////////////////////////////////////////
-- RESULTADO 2 — SOLO los problemas (lo que hay que aplicar)
-- ////////////////////////////////////////////////////////////////////////////
SELECT bloque, migracion, objeto, resultado
FROM _schema_check
WHERE resultado NOT LIKE '✅%'
ORDER BY id;
