-- ============================================================================
-- Bloque F — recurso fuera de servicio: tests estructurales
-- ============================================================================
-- Aplicá 20260612100000_recurso_fuera_servicio.sql, pegá este archivo en el SQL
-- editor de Supabase (EKKO) y ejecutá. Devuelve area · caso · resultado.
-- ============================================================================

DROP TABLE IF EXISTS _recurso_fs_resultado;
CREATE TEMP TABLE _recurso_fs_resultado (
  id serial PRIMARY KEY, area text, caso text, resultado text
);

DO $$
DECLARE v_count integer;
BEGIN
  -- 1. Columnas nuevas en recursos
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='recursos'
    AND column_name IN ('fuera_de_servicio','fuera_de_servicio_motivo');
  INSERT INTO _recurso_fs_resultado (area, caso, resultado) VALUES
    ('recursos', 'columnas fuera_de_servicio(_motivo) existen',
     CASE WHEN v_count=2 THEN '✅ PASS' ELSE '❌ FAIL — hay '||v_count||'/2' END);

  -- 2. Default false en fuera_de_servicio
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='recursos'
    AND column_name='fuera_de_servicio' AND column_default LIKE '%false%';
  INSERT INTO _recurso_fs_resultado (area, caso, resultado) VALUES
    ('recursos', 'fuera_de_servicio default false',
     CASE WHEN v_count=1 THEN '✅ PASS' ELSE '❌ FAIL' END);

  -- 3. Trigger BEFORE INSERT en reservas
  SELECT count(*) INTO v_count
  FROM information_schema.triggers
  WHERE event_object_schema='public' AND event_object_table='reservas'
    AND trigger_name='trg_reservas_recurso_fuera_servicio'
    AND event_manipulation='INSERT';
  INSERT INTO _recurso_fs_resultado (area, caso, resultado) VALUES
    ('reservas', 'trigger de bloqueo BEFORE INSERT existe',
     CASE WHEN v_count>=1 THEN '✅ PASS' ELSE '❌ FAIL — falta el trigger' END);

  -- 4. La función del trigger existe
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reservas_bloquear_recurso_fuera_servicio';
  INSERT INTO _recurso_fs_resultado (area, caso, resultado) VALUES
    ('reservas', 'función del trigger existe',
     CASE WHEN v_count=1 THEN '✅ PASS' ELSE '❌ FAIL' END);
END $$;

SELECT area, caso, resultado FROM _recurso_fs_resultado ORDER BY id;
