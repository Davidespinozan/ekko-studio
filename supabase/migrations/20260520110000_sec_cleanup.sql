-- ============================================================================
-- SEC-CLEANUP — higiene de seguridad pre-launch
-- ============================================================================
-- Elimina objetos de BD peligrosos o huérfanos antes del launch de Cravia.
-- Verificación previa (grep en el repo): 0 referencias activas a los 3
-- objetos. Ver detalle por objeto abajo.
--
-- 1. dev_crear_recepcionista  — defensivo (ya dropeada por 20260514130000)
-- 2. generar_clases_recurrentes — RPC fantasma (concepto SALA, no EKKO)
--
-- create-team-member NO entra acá: es una Edge Function (Deno), no una
-- función Postgres. Se elimina del dashboard de Supabase — acción manual.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. dev_crear_recepcionista  (DROP defensivo, idempotente)
-- ----------------------------------------------------------------------------
-- Helper DEV que creaba recepcionistas sin cuenta de Auth — agujero si llega
-- a producción. YA fue eliminada por la migración 20260514130000_admin_user_
-- management.sql:10. Este DROP es belt-and-suspenders: idempotente (IF EXISTS),
-- no-op en una BD migrada al día, y cubre el caso de drift donde 130000 no
-- se hubiera aplicado. Deja el repo explícito: "esta función NO debe existir".
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS dev_crear_recepcionista(text, text);


-- ----------------------------------------------------------------------------
-- 2. generar_clases_recurrentes  (RPC fantasma)
-- ----------------------------------------------------------------------------
-- Función Postgres que vive solo en la BD desplegada — NUNCA estuvo en el
-- repo (0 referencias en código). Pertenece al concepto "clases recurrentes"
-- de SALA, no a EKKO; su última corrida devolvió clases_creadas:0. Se elimina.
--
-- No conocemos su firma exacta (no está versionada) y podría tener overloads.
-- El bloque DO descubre toda función `generar_clases_recurrentes` en `public`
-- y la dropea, sea cual sea su firma. Sin CASCADE: si algo dependiera de ella
-- (ej. un job pg_cron), el DROP falla en voz alta — mejor que romper en
-- silencio. En ese caso, investigar la dependencia antes de re-aplicar.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_dropped integer := 0;
BEGIN
  FOR r IN
    SELECT 'DROP FUNCTION IF EXISTS public.' || quote_ident(p.proname)
           || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS stmt
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'generar_clases_recurrentes'
  LOOP
    EXECUTE r.stmt;
    v_dropped := v_dropped + 1;
  END LOOP;

  IF v_dropped = 0 THEN
    RAISE NOTICE 'generar_clases_recurrentes: no existía — nada que eliminar.';
  ELSE
    RAISE NOTICE 'generar_clases_recurrentes: % definición(es) eliminada(s).', v_dropped;
  END IF;
END $$;
