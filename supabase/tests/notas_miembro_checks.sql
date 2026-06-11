-- ============================================================================
-- Bloque E — notas_miembro: tests estructurales
-- ============================================================================
-- Cómo usar: aplicá 20260611200000_notas_miembro.sql, pegá este archivo en el
-- SQL editor de Supabase (EKKO) y ejecutá. Devuelve una tabla area·caso·resultado.
--
-- Cubre la forma de la RLS (existencia de policies por comando + grants). El
-- comportamiento fino por rol (member no lee, recepción edita solo lo suyo) se
-- valida en el operativo manual con 2 cuentas.
-- ============================================================================

DROP TABLE IF EXISTS _notas_miembro_resultado;
CREATE TEMP TABLE _notas_miembro_resultado (
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
  WHERE table_schema = 'public' AND table_name = 'notas_miembro';
  INSERT INTO _notas_miembro_resultado (area, caso, resultado) VALUES
    ('notas_miembro', 'la tabla existe',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — no existe' END);

  -- 2. RLS habilitada
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'notas_miembro' AND c.relrowsecurity;
  INSERT INTO _notas_miembro_resultado (area, caso, resultado) VALUES
    ('notas_miembro', 'RLS habilitada',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — RLS apagada' END);

  -- 3. Una policy por cada comando (SELECT/INSERT/UPDATE/DELETE)
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'notas_miembro'
    AND cmd IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  INSERT INTO _notas_miembro_resultado (area, caso, resultado) VALUES
    ('notas_miembro', 'policies SELECT/INSERT/UPDATE/DELETE presentes',
     CASE WHEN v_count = 4 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || v_count || ' policy(s) (esperaba 4)' END);

  -- 4. authenticated tiene los 4 grants (la RLS restringe filas)
  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'notas_miembro'
    AND grantee = 'authenticated' AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  INSERT INTO _notas_miembro_resultado (area, caso, resultado) VALUES
    ('notas_miembro', 'authenticated con los 4 grants',
     CASE WHEN v_count = 4 THEN '✅ PASS' ELSE '❌ FAIL — tiene ' || v_count || '/4 grants' END);

  -- 5. FKs a tenants y usuarios (miembro_id, autor_id)
  SELECT count(*) INTO v_count
  FROM information_schema.table_constraints
  WHERE table_schema = 'public' AND table_name = 'notas_miembro' AND constraint_type = 'FOREIGN KEY';
  INSERT INTO _notas_miembro_resultado (area, caso, resultado) VALUES
    ('notas_miembro', 'FKs presentes (tenant + miembro + autor)',
     CASE WHEN v_count >= 3 THEN '✅ PASS' ELSE '❌ FAIL — hay ' || v_count || ' FKs (esperaba 3)' END);

  -- 6. El cron escribe audit_log: la función existe (deuda de D cerrada)
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'marcar_no_shows';
  INSERT INTO _notas_miembro_resultado (area, caso, resultado) VALUES
    ('cron-audit', 'marcar_no_shows existe (revisar que inserte audit_log)',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — no existe' END);
END $$;

SELECT area, caso, resultado FROM _notas_miembro_resultado ORDER BY id;
