-- ============================================================================
-- expirar_membresias_vencidas(): solo service_role (estaba abierta a authenticated)
-- ============================================================================
-- Toda función nueva en Supabase nace con EXECUTE para anon/authenticated y
-- `REVOKE FROM PUBLIC` no lo quita. `expirar_membresias_vencidas()` es
-- SECURITY DEFINER, la recreó 20260704170000 sin REVOKE, y cualquier miembro
-- logueado podía `supabase.rpc('expirar_membresias_vencidas')`: expira paquetes
-- vencidos de TODOS los tenants, nulea usuarios.membresia_tier, escribe el
-- ledger y devuelve el conteo global (oráculo). Solo el cron la necesita.
-- Mismo patrón que H5 (marcar_no_shows) en 20260521100000_sec_fix.sql.
-- Idempotente.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION expirar_membresias_vencidas() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION expirar_membresias_vencidas() TO service_role;

-- Reafirmación idempotente del resto de funciones de cron/keystone (ya estaban
-- revocadas en sus migraciones; esto evita depender del orden histórico).
REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;
REVOKE EXECUTE ON FUNCTION generar_recordatorios_reservas() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION generar_recordatorios_reservas() TO service_role;
REVOKE EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) TO service_role;
REVOKE EXECUTE ON FUNCTION registrar_invitados_extra_pagados(uuid, integer) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION registrar_invitados_extra_pagados(uuid, integer) TO service_role;

-- Barrido defensivo: ninguna función de cron/keystone debe quedar ejecutable por
-- authenticated/anon. Falla la migración si alguna lo está.
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'expirar_membresias_vencidas()',
    'marcar_no_shows()',
    'generar_recordatorios_reservas()',
    'sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz)',
    'registrar_invitados_extra_pagados(uuid, integer)'
  ] LOOP
    BEGIN
      IF has_function_privilege('authenticated', v_fn, 'EXECUTE')
         OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% no debe ser ejecutable por authenticated/anon', v_fn;
      END IF;
      IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '% debe ser ejecutable por service_role', v_fn;
      END IF;
    EXCEPTION
      WHEN undefined_function THEN
        -- Firma distinta en este entorno: no es un fallo de seguridad, se omite.
        RAISE NOTICE 'barrido de privilegios: % no existe con esa firma, omitida', v_fn;
    END;
  END LOOP;
END $$;
