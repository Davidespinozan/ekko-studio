-- ============================================================================
-- SEC-FIX — Tests de explotación (confirmar que los agujeros están cerrados)
-- ============================================================================
-- Cómo usar:
--   1. Aplicá primero la migración 20260521100000_sec_fix.sql.
--   2. Pegá TODO este archivo en el SQL editor de Supabase (EKKO) y ejecutá.
--      Tal cual — no hay nada que reemplazar.
--
-- Imprime ✅ PASS / ❌ FAIL / ⚠️ SKIP por cada caso en los NOTICE. Todo va
-- dentro de BEGIN/ROLLBACK → no persiste nada.
--
-- Cubre: C2 (auto-elevación de rol), C3 (funciones dev), H1 (columnas
-- sensibles), H2 (status en reservas), H3 (cancelación cross-tenant),
-- H5 (marcar_no_shows).
-- ============================================================================


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 1 — Checks estructurales (C3, H1, H5, C2-trigger)
-- ////////////////////////////////////////////////////////////////////////////
DO $$
DECLARE
  v_count integer;
BEGIN
  -- C3 — no debe quedar NINGUNA función dev_*
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'dev\_%';
  IF v_count = 0
    THEN RAISE NOTICE 'C3 ✅ PASS — no quedan funciones dev_*';
    ELSE RAISE NOTICE 'C3 ❌ FAIL — todavía hay % función(es) dev_*', v_count;
  END IF;

  -- H1 — `usuarios` ya NO tiene las columnas sensibles
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'usuarios'
    AND column_name IN ('ob_data', 'stripe_customer_id');
  IF v_count = 0
    THEN RAISE NOTICE 'H1 ✅ PASS — usuarios no expone ob_data/stripe_customer_id';
    ELSE RAISE NOTICE 'H1 ❌ FAIL — usuarios todavía tiene % columna(s) sensible(s)', v_count;
  END IF;

  -- H1 — la tabla privada existe y tiene RLS habilitado
  IF to_regclass('public.usuarios_datos_privados') IS NULL THEN
    RAISE NOTICE 'H1 ❌ FAIL — usuarios_datos_privados no existe';
  ELSE
    SELECT count(*) INTO v_count
    FROM pg_class WHERE relname = 'usuarios_datos_privados' AND relrowsecurity;
    IF v_count = 1
      THEN RAISE NOTICE 'H1 ✅ PASS — usuarios_datos_privados existe con RLS';
      ELSE RAISE NOTICE 'H1 ❌ FAIL — usuarios_datos_privados sin RLS';
    END IF;
  END IF;

  -- H1 — solo dueño (udp_select_self) y admin (udp_admin_all); recepción no
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'usuarios_datos_privados'
    AND policyname IN ('udp_select_self', 'udp_admin_all');
  IF v_count = 2
    THEN RAISE NOTICE 'H1 ✅ PASS — policies dueño+admin presentes (recepción no entra)';
    ELSE RAISE NOTICE 'H1 ❌ FAIL — faltan policies en usuarios_datos_privados (% de 2)', v_count;
  END IF;

  -- H5 — marcar_no_shows NO ejecutable por authenticated, SÍ por service_role
  IF NOT has_function_privilege('authenticated', 'marcar_no_shows()', 'EXECUTE')
     AND has_function_privilege('service_role', 'marcar_no_shows()', 'EXECUTE')
    THEN RAISE NOTICE 'H5 ✅ PASS — marcar_no_shows solo service_role';
    ELSE RAISE NOTICE 'H5 ❌ FAIL — marcar_no_shows con permisos incorrectos';
  END IF;

  -- C2 — el trigger protector existe sobre usuarios
  SELECT count(*) INTO v_count
  FROM pg_trigger WHERE tgname = 'trg_proteger_columnas_usuarios';
  IF v_count = 1
    THEN RAISE NOTICE 'C2 ✅ PASS — trigger trg_proteger_columnas_usuarios instalado';
    ELSE RAISE NOTICE 'C2 ❌ FAIL — trigger protector ausente';
  END IF;
END $$;


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 2 — Comportamiento de RPCs (H2, H3) — solo simula jwt.claims
-- ////////////////////////////////////////////////////////////////////////////
BEGIN;
DO $$
DECLARE
  v_tenant            uuid;
  v_auth_recepcion    uuid;
  v_auth_suspendido   uuid;
  v_usuario_susp      uuid;
  v_recurso           uuid;
  v_reserva_otro_tnt  uuid;
  v_result            jsonb;
BEGIN
  SELECT u.auth_id, u.tenant_id INTO v_auth_recepcion, v_tenant
  FROM usuarios u WHERE u.rol = 'recepcionista' AND u.auth_id IS NOT NULL
  ORDER BY u.created_at LIMIT 1;

  IF v_auth_recepcion IS NULL THEN
    RAISE NOTICE 'PARTE 2 ABORT — no hay cuenta recepcionista con auth_id.';
    RETURN;
  END IF;

  SELECT id INTO v_recurso FROM recursos
  WHERE activo AND tenant_id = v_tenant ORDER BY created_at LIMIT 1;

  -- H2 — un miembro NO activo no puede reservar (gate de status en backend)
  SELECT id, auth_id INTO v_usuario_susp, v_auth_suspendido
  FROM usuarios
  WHERE rol = 'miembro' AND status <> 'activo' AND tenant_id = v_tenant
    AND auth_id IS NOT NULL
  ORDER BY created_at LIMIT 1;

  IF v_usuario_susp IS NULL OR v_recurso IS NULL THEN
    RAISE NOTICE 'H2 ⚠️  SKIP — no hay miembro no-activo con auth_id (o sin recurso)';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_suspendido)::text, true);
    BEGIN
      v_result := reservar_recurso_atomic(
        v_recurso, now() + interval '300 hours', 60, 0, 'sec-fix-h2');
      RAISE NOTICE 'H2 ❌ FAIL — un miembro no-activo pudo reservar';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%EKKO_USUARIO_INACTIVO%'
        THEN RAISE NOTICE 'H2 ✅ PASS — reserva bloqueada por status (backend)';
        ELSE RAISE NOTICE 'H2 ⚠️  bloqueado por otro error: %', SQLERRM;
      END IF;
    END;
  END IF;

  -- H3 — recepción/admin NO puede cancelar una reserva de OTRO tenant
  SELECT id INTO v_reserva_otro_tnt
  FROM reservas
  WHERE tenant_id <> v_tenant AND status = 'confirmada'
    AND slot_inicio > now()
  ORDER BY created_at LIMIT 1;

  IF v_reserva_otro_tnt IS NULL THEN
    RAISE NOTICE 'H3 ⚠️  SKIP — no hay reserva confirmada futura de otro tenant';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_recepcion)::text, true);
    BEGIN
      PERFORM cancelar_reserva_atomic(v_reserva_otro_tnt, 'sec-fix-h3');
      RAISE NOTICE 'H3 ❌ FAIL — recepción canceló una reserva de otro tenant';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%EKKO_TENANT_DIFERENTE%'
        THEN RAISE NOTICE 'H3 ✅ PASS — cancelación cross-tenant bloqueada';
        ELSE RAISE NOTICE 'H3 ⚠️  bloqueado por otro error: %', SQLERRM;
      END IF;
    END;
  END IF;
END $$;
ROLLBACK;


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 3 — C2 comportamiento: simula el rol Postgres `authenticated`
-- ////////////////////////////////////////////////////////////////////////////
-- El trigger distingue al atacante por current_user='authenticated'. Para
-- reproducir un ataque real hay que SET ROLE authenticated (no alcanza con
-- simular jwt.claims, que solo afecta a auth.uid()).
-- ////////////////////////////////////////////////////////////////////////////
BEGIN;
DO $$
DECLARE
  v_id_miembro   uuid;
  v_auth_miembro uuid;
  v_rol_final    text;
  v_tel_final    text;
BEGIN
  -- Descubrir un miembro (todavía como el rol de la sesión).
  SELECT id, auth_id INTO v_id_miembro, v_auth_miembro
  FROM usuarios
  WHERE rol = 'miembro' AND auth_id IS NOT NULL
  ORDER BY created_at LIMIT 1;

  IF v_id_miembro IS NULL THEN
    RAISE NOTICE 'C2 ⚠️  SKIP — no hay miembro con auth_id';
    RETURN;
  END IF;

  -- Pasar al rol `authenticated` + simular la sesión del miembro.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_miembro)::text, true);

  -- C2a — el miembro intenta auto-elevarse a admin → debe fallar
  BEGIN
    UPDATE usuarios SET rol = 'admin' WHERE id = v_id_miembro;
    RAISE NOTICE 'C2a ❌ FAIL — un miembro se auto-elevó a admin';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%'
      THEN RAISE NOTICE 'C2a ✅ PASS — auto-elevación de rol bloqueada';
      ELSE RAISE NOTICE 'C2a ⚠️  bloqueado por otro error: %', SQLERRM;
    END IF;
  END;

  -- C2b — el miembro intenta auto-activarse (status) → debe fallar
  BEGIN
    UPDATE usuarios SET status = 'activo' WHERE id = v_id_miembro;
    RAISE NOTICE 'C2b ❌ FAIL — un miembro cambió su propio status';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%'
      THEN RAISE NOTICE 'C2b ✅ PASS — cambio de status bloqueado';
      ELSE RAISE NOTICE 'C2b ⚠️  bloqueado por otro error: %', SQLERRM;
    END IF;
  END;

  -- C2c — el miembro SÍ puede editar campos no sensibles (no se rompió)
  BEGIN
    UPDATE usuarios SET telefono = '6669999999' WHERE id = v_id_miembro;
    RAISE NOTICE 'C2c ✅ PASS — el miembro sigue pudiendo editar su teléfono';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'C2c ❌ FAIL — se rompió el self-update legítimo: %', SQLERRM;
  END;

  RESET ROLE;
END $$;
ROLLBACK;

-- ============================================================================
-- Notas:
--  - C1 (fake-signup) se cubre en src/__tests__/fake-signup.test.ts.
--  - H4 (logs de password) — verificado: las funciones no loguean el password
--    ni la respuesta (solo el objeto Error).
--  - H6 (QR_JWT_SECRET) — verificar el valor en las env vars de Netlify prod.
-- ============================================================================
