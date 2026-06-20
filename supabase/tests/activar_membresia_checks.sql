-- ============================================================================
-- Pagos — activar_membresia: tests estructurales
-- ============================================================================
-- Aplicá 20260612200000_activar_membresia.sql, pegá este archivo en el SQL
-- editor de Supabase (EKKO) y ejecutá.
-- ============================================================================

DROP TABLE IF EXISTS _activar_resultado;
CREATE TEMP TABLE _activar_resultado (id serial PRIMARY KEY, area text, caso text, resultado text);

DO $$
DECLARE v_count integer;
BEGIN
  -- 1. La función existe
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'activar_membresia';
  INSERT INTO _activar_resultado (area, caso, resultado) VALUES
    ('activar_membresia', 'la función existe',
     CASE WHEN v_count >= 1 THEN '✅ PASS' ELSE '❌ FAIL' END);

  -- 2. Es SECURITY DEFINER
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'activar_membresia' AND p.prosecdef = true;
  INSERT INTO _activar_resultado (area, caso, resultado) VALUES
    ('activar_membresia', 'SECURITY DEFINER',
     CASE WHEN v_count >= 1 THEN '✅ PASS' ELSE '❌ FAIL' END);

  -- 3. authenticated NO puede ejecutarla (solo service_role)
  SELECT count(*) INTO v_count
  FROM information_schema.role_routine_grants
  WHERE routine_schema = 'public' AND routine_name = 'activar_membresia'
    AND grantee = 'authenticated';
  INSERT INTO _activar_resultado (area, caso, resultado) VALUES
    ('activar_membresia', 'authenticated SIN execute',
     CASE WHEN v_count = 0 THEN '✅ PASS' ELSE '❌ FAIL — authenticated puede ejecutarla' END);

  -- 4. tiers.stripe_price_id existe (para el checkout)
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tiers' AND column_name = 'stripe_price_id';
  INSERT INTO _activar_resultado (area, caso, resultado) VALUES
    ('tiers', 'stripe_price_id existe',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL' END);
END $$;

SELECT area, caso, resultado FROM _activar_resultado ORDER BY id;
