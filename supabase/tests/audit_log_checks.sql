-- ============================================================================
-- Bloque A — audit_log: tests estructurales (inmutabilidad por construcción)
-- ============================================================================
-- Cómo usar:
--   1. Aplicá primero la migración 20260611100000_audit_log.sql.
--   2. Pegá TODO este archivo en el SQL editor de Supabase (EKKO) y ejecutá.
--      Tal cual — no hay nada que reemplazar.
--
-- Resultado: una TABLA al final con area · caso · resultado (✅/❌).
--
-- Cubre la garantía clave del Bloque A: audit_log es insert-only por
-- construcción (RLS on, 0 policies de INSERT/UPDATE/DELETE para authenticated)
-- y la lectura está acotada (admin todo el tenant; recepción solo usuarios).
-- ============================================================================

DROP TABLE IF EXISTS _audit_log_resultado;
CREATE TEMP TABLE _audit_log_resultado (
  id serial PRIMARY KEY,
  area text,
  caso text,
  resultado text
);

DO $$
DECLARE
  v_count integer;
BEGIN
  -- 1. La tabla existe
  SELECT count(*) INTO v_count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_log';
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'la tabla existe',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — no existe' END);

  -- 2. RLS habilitada
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'audit_log' AND c.relrowsecurity;
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'RLS habilitada',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — RLS apagada' END);

  -- 3. CERO policies de INSERT (insert solo service_role, que bypassa RLS)
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'audit_log' AND cmd = 'INSERT';
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'sin policy de INSERT para authenticated',
     CASE WHEN v_count = 0 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || v_count || ' policy(s) de INSERT' END);

  -- 4. CERO policies de UPDATE (inmutable)
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'audit_log' AND cmd = 'UPDATE';
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'sin policy de UPDATE (inmutable)',
     CASE WHEN v_count = 0 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || v_count || ' policy(s) de UPDATE' END);

  -- 5. CERO policies de DELETE (inmutable)
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'audit_log' AND cmd = 'DELETE';
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'sin policy de DELETE (inmutable)',
     CASE WHEN v_count = 0 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || v_count || ' policy(s) de DELETE' END);

  -- 6. Existen las 2 policies de SELECT (admin + recepción)
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'audit_log' AND cmd = 'SELECT';
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'dos policies de SELECT (admin + recepción)',
     CASE WHEN v_count = 2 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || v_count || ' policy(s) de SELECT (esperaba 2)' END);

  -- 7. authenticated NO tiene INSERT/UPDATE/DELETE concedido
  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'audit_log'
    AND grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'authenticated sin grant de escritura',
     CASE WHEN v_count = 0 THEN '✅ PASS' ELSE '❌ FAIL — authenticated tiene ' || v_count || ' grant(s) de escritura' END);

  -- 8. Los índices existen
  SELECT count(*) INTO v_count
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'audit_log'
    AND indexname IN ('audit_log_tenant_target_idx', 'audit_log_tenant_creada_idx');
  INSERT INTO _audit_log_resultado (area, caso, resultado) VALUES
    ('audit_log', 'índices de consulta presentes',
     CASE WHEN v_count = 2 THEN '✅ PASS' ELSE '❌ FAIL — faltan índices (' || v_count || '/2)' END);
END $$;

SELECT area, caso, resultado FROM _audit_log_resultado ORDER BY id;
