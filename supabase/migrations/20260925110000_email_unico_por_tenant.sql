-- ============================================================================
-- Correo único por estudio sin importar mayúsculas ni espacios.
-- `UNIQUE (tenant_id, email)` (20260514100200) es sensible a mayúsculas y el
-- índice `lower(email)` no era único. Se crea el índice SOLO si hoy no hay
-- duplicados por capitalización: si los hay, se avisa y se deja para revisar
-- (precheck: supabase/precheck_identidad_fase1.sql). Nunca se borra nada.
-- ============================================================================
DO $$
DECLARE
  v_dup integer;
BEGIN
  SELECT count(*) INTO v_dup
  FROM (
    SELECT tenant_id, lower(trim(email))
    FROM usuarios
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;

  IF v_dup > 0 THEN
    RAISE WARNING
      'EKKO: % correo(s) repetidos por mayúsculas/espacios. NO se crea usuarios_tenant_email_lower_uniq: revisa supabase/precheck_identidad_fase1.sql y vuelve a correr esta migración.',
      v_dup;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS usuarios_tenant_email_lower_uniq
      ON usuarios (tenant_id, lower(trim(email)));
  END IF;
END $$;
