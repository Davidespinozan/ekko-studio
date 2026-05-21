-- ============================================================================
-- SEC-FIX — Tests de explotación (confirmar que los agujeros están cerrados)
-- ============================================================================
-- Cómo usar:
--   1. Aplicá primero la migración 20260521100000_sec_fix.sql.
--   2. Pegá TODO este archivo en el SQL editor de Supabase (EKKO) y ejecutá.
--      Tal cual — no hay nada que reemplazar.
--
-- Resultado: una TABLA al final con area · caso · resultado (✅/❌/⚠️/⏭).
-- No usa RAISE NOTICE — devuelve filas, más fácil de leer en el editor.
--
-- Cubre: C2 (las 6 columnas privilegiadas + 2 vías legítimas), C3 (funciones
-- dev), H1 (columnas sensibles), H2 (status en reservas), H3 (cancelación
-- cross-tenant), H5 (marcar_no_shows).
--
-- SEC-FIX-2: el caso C2b (auto-cambio de status) antes daba un FALSO POSITIVO
-- — el test hacía `SET status='activo'` sobre un miembro que YA estaba activo
-- (no-op → el trigger no dispara → parecía un agujero). Ahora cada ataque usa
-- un valor genuinamente DISTINTO del actual.
--
-- Cómo se prueba un UPDATE sin dejar rastro: se ejecuta dentro de un sub-bloque
-- BEGIN/EXCEPTION; si el UPDATE no fue rechazado, se lanza un marcador
-- 'EKKO_TEST_ROLLBACK' que revierte el sub-bloque. Las variables plpgsql NO son
-- transaccionales → el resultado capturado sobrevive aunque el dato se revierta.
-- ============================================================================

DROP TABLE IF EXISTS _sec_fix_resultado;
CREATE TEMP TABLE _sec_fix_resultado (
  id serial PRIMARY KEY,
  area text,
  caso text,
  resultado text
);


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
  INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
    ('C3', 'No quedan funciones dev_*',
     CASE WHEN v_count = 0 THEN '✅ PASS'
          ELSE '❌ FAIL — todavía hay ' || v_count || ' función(es) dev_*' END);

  -- H1 — `usuarios` ya NO tiene las columnas sensibles
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'usuarios'
    AND column_name IN ('ob_data', 'stripe_customer_id');
  INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
    ('H1', 'usuarios no expone ob_data/stripe_customer_id',
     CASE WHEN v_count = 0 THEN '✅ PASS'
          ELSE '❌ FAIL — usuarios todavía tiene ' || v_count || ' columna(s) sensible(s)' END);

  -- H1 — la tabla privada existe con RLS habilitado
  IF to_regclass('public.usuarios_datos_privados') IS NULL THEN
    INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
      ('H1', 'usuarios_datos_privados existe con RLS', '❌ FAIL — la tabla no existe');
  ELSE
    SELECT count(*) INTO v_count
    FROM pg_class WHERE relname = 'usuarios_datos_privados' AND relrowsecurity;
    INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
      ('H1', 'usuarios_datos_privados existe con RLS',
       CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — sin RLS' END);
  END IF;

  -- H1 — solo dueño (udp_select_self) y admin (udp_admin_all); recepción no
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE tablename = 'usuarios_datos_privados'
    AND policyname IN ('udp_select_self', 'udp_admin_all');
  INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
    ('H1', 'Policies dueño+admin presentes (recepción no entra)',
     CASE WHEN v_count = 2 THEN '✅ PASS'
          ELSE '❌ FAIL — faltan policies (' || v_count || ' de 2)' END);

  -- H5 — marcar_no_shows NO ejecutable por authenticated, SÍ por service_role
  INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
    ('H5', 'marcar_no_shows solo ejecutable por service_role',
     CASE WHEN NOT has_function_privilege('authenticated', 'marcar_no_shows()', 'EXECUTE')
               AND has_function_privilege('service_role', 'marcar_no_shows()', 'EXECUTE')
          THEN '✅ PASS' ELSE '❌ FAIL — permisos incorrectos' END);

  -- C2 — el trigger protector existe sobre usuarios
  SELECT count(*) INTO v_count
  FROM pg_trigger WHERE tgname = 'trg_proteger_columnas_usuarios';
  INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
    ('C2', 'Trigger trg_proteger_columnas_usuarios instalado',
     CASE WHEN v_count = 1 THEN '✅ PASS' ELSE '❌ FAIL — trigger ausente' END);
END $$;


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 2 — Comportamiento de RPCs (H2, H3) — solo simula jwt.claims
-- ////////////////////////////////////////////////////////////////////////////
DO $$
DECLARE
  v_tenant            uuid;
  v_auth_recepcion    uuid;
  v_auth_suspendido   uuid;
  v_usuario_susp      uuid;
  v_recurso           uuid;
  v_reserva_otro_tnt  uuid;
  v_r_h2              text;
  v_r_h3              text;
BEGIN
  SELECT u.auth_id, u.tenant_id INTO v_auth_recepcion, v_tenant
  FROM usuarios u WHERE u.rol = 'recepcionista' AND u.auth_id IS NOT NULL
  ORDER BY u.created_at LIMIT 1;

  IF v_auth_recepcion IS NULL THEN
    INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
      ('H2', 'Miembro no-activo no puede reservar', '⏭ SKIP — sin cuenta recepcionista'),
      ('H3', 'Recepción no cancela reservas de otro tenant', '⏭ SKIP — sin cuenta recepcionista');
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
    v_r_h2 := '⏭ SKIP — no hay miembro no-activo con auth_id (o sin recurso)';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_suspendido)::text, true);
    BEGIN
      PERFORM reservar_recurso_atomic(
        v_recurso, now() + interval '300 hours', 60, 0, 'sec-fix-h2');
      v_r_h2 := '❌ FAIL — un miembro no-activo pudo reservar';
      RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
      ELSIF SQLERRM LIKE '%EKKO_USUARIO_INACTIVO%' THEN
        v_r_h2 := '✅ PASS — reserva bloqueada por status (backend)';
      ELSE
        v_r_h2 := '⚠️ WARN — bloqueado por otro error: ' || SQLERRM;
      END IF;
    END;
  END IF;
  INSERT INTO _sec_fix_resultado (area, caso, resultado)
  VALUES ('H2', 'Miembro no-activo no puede reservar', v_r_h2);

  -- H3 — recepción/admin NO puede cancelar una reserva de OTRO tenant
  SELECT id INTO v_reserva_otro_tnt
  FROM reservas
  WHERE tenant_id <> v_tenant AND status = 'confirmada' AND slot_inicio > now()
  ORDER BY created_at LIMIT 1;

  IF v_reserva_otro_tnt IS NULL THEN
    v_r_h3 := '⏭ SKIP — no hay reserva confirmada futura de otro tenant';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_recepcion)::text, true);
    BEGIN
      PERFORM cancelar_reserva_atomic(v_reserva_otro_tnt, 'sec-fix-h3');
      v_r_h3 := '❌ FAIL — recepción canceló una reserva de otro tenant';
      RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
      ELSIF SQLERRM LIKE '%EKKO_TENANT_DIFERENTE%' THEN
        v_r_h3 := '✅ PASS — cancelación cross-tenant bloqueada';
      ELSE
        v_r_h3 := '⚠️ WARN — bloqueado por otro error: ' || SQLERRM;
      END IF;
    END;
  END IF;
  INSERT INTO _sec_fix_resultado (area, caso, resultado)
  VALUES ('H3', 'Recepción no cancela reservas de otro tenant', v_r_h3);
END $$;


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 3 — C2: las 6 columnas privilegiadas + las vías legítimas
-- ////////////////////////////////////////////////////////////////////////////
-- El trigger distingue al atacante por current_user='authenticated'. Hay que
-- SET ROLE authenticated (simular jwt.claims solo no alcanza). Los resultados
-- se capturan en variables y se insertan DESPUÉS de RESET ROLE.
-- ////////////////////////////////////////////////////////////////////////////
DO $$
DECLARE
  v_id_miembro     uuid;
  v_auth_miembro   uuid;
  v_tenant_miembro uuid;
  v_status_actual  text;
  v_tier_actual    text;
  v_noshows_actual integer;
  v_id_admin       uuid;
  v_auth_admin     uuid;
  v_status_nuevo   text;
  v_tier_nuevo     text;
  v_r_rol          text;
  v_r_status       text;
  v_r_tenant       text;
  v_r_tier         text;
  v_r_noshows      text;
  v_r_bloq         text;
  v_r_tel          text;
  v_r_legit_admin  text := '⏭ SKIP — no hay admin con auth_id en el tenant';
  v_r_legit_srv    text;
BEGIN
  -- Descubrir un miembro y un admin del mismo tenant (como rol de la sesión).
  SELECT id, auth_id, tenant_id, status, membresia_tier, no_shows_count
    INTO v_id_miembro, v_auth_miembro, v_tenant_miembro,
         v_status_actual, v_tier_actual, v_noshows_actual
  FROM usuarios
  WHERE rol = 'miembro' AND auth_id IS NOT NULL
  ORDER BY created_at LIMIT 1;

  IF v_id_miembro IS NULL THEN
    INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
      ('C2', 'Ataques de auto-elevación', '⏭ SKIP — no hay miembro con auth_id');
    RETURN;
  END IF;

  SELECT id, auth_id INTO v_id_admin, v_auth_admin
  FROM usuarios
  WHERE rol = 'admin' AND auth_id IS NOT NULL AND tenant_id = v_tenant_miembro
  ORDER BY created_at LIMIT 1;

  -- Valores GENUINAMENTE distintos del actual (si no, el UPDATE sería no-op
  -- y el trigger — correctamente — no dispararía → falso positivo).
  v_status_nuevo := CASE WHEN v_status_actual = 'activo' THEN 'suspendido' ELSE 'activo' END;
  v_tier_nuevo   := CASE WHEN v_tier_actual IS DISTINCT FROM 'pro' THEN 'pro' ELSE 'basica' END;

  -- ===== Sesión simulada del miembro, como rol Postgres `authenticated` =====
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_miembro)::text, true);

  -- C2a — rol → admin (debe BLOQUEARSE)
  BEGIN
    UPDATE usuarios SET rol = 'admin' WHERE id = v_id_miembro;
    v_r_rol := '❌ FAIL — el miembro se auto-elevó a admin';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSIF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%' THEN v_r_rol := '✅ PASS';
    ELSE v_r_rol := '⚠️ WARN — otro error: ' || SQLERRM;
    END IF;
  END;

  -- C2b — status → distinto (debe BLOQUEARSE) ← el que daba falso positivo
  BEGIN
    UPDATE usuarios SET status = v_status_nuevo WHERE id = v_id_miembro;
    v_r_status := '❌ FAIL — el miembro cambió su propio status';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSIF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%' THEN v_r_status := '✅ PASS';
    ELSE v_r_status := '⚠️ WARN — otro error: ' || SQLERRM;
    END IF;
  END;

  -- C2 — tenant_id → otro (debe BLOQUEARSE)
  BEGIN
    UPDATE usuarios SET tenant_id = gen_random_uuid() WHERE id = v_id_miembro;
    v_r_tenant := '❌ FAIL — el miembro cambió su tenant_id';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSIF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%' THEN v_r_tenant := '✅ PASS';
    ELSE v_r_tenant := '⚠️ WARN — otro error: ' || SQLERRM;
    END IF;
  END;

  -- C2 — membresia_tier → distinto (debe BLOQUEARSE)
  BEGIN
    UPDATE usuarios SET membresia_tier = v_tier_nuevo WHERE id = v_id_miembro;
    v_r_tier := '❌ FAIL — el miembro cambió su membresia_tier';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSIF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%' THEN v_r_tier := '✅ PASS';
    ELSE v_r_tier := '⚠️ WARN — otro error: ' || SQLERRM;
    END IF;
  END;

  -- C2 — no_shows_count → +1 (debe BLOQUEARSE)
  BEGIN
    UPDATE usuarios SET no_shows_count = v_noshows_actual + 1 WHERE id = v_id_miembro;
    v_r_noshows := '❌ FAIL — el miembro cambió su no_shows_count';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSIF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%' THEN v_r_noshows := '✅ PASS';
    ELSE v_r_noshows := '⚠️ WARN — otro error: ' || SQLERRM;
    END IF;
  END;

  -- C2 — bloqueado_hasta → futuro (debe BLOQUEARSE: borrar/poner penalización)
  BEGIN
    UPDATE usuarios SET bloqueado_hasta = now() + interval '30 days' WHERE id = v_id_miembro;
    v_r_bloq := '❌ FAIL — el miembro cambió su bloqueado_hasta';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSIF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%' THEN v_r_bloq := '✅ PASS';
    ELSE v_r_bloq := '⚠️ WARN — otro error: ' || SQLERRM;
    END IF;
  END;

  -- C2c — teléfono (campo NO sensible): el self-update legítimo SÍ funciona
  BEGIN
    UPDATE usuarios SET telefono = '6660000000' WHERE id = v_id_miembro;
    v_r_tel := '✅ PASS';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSE v_r_tel := '❌ FAIL — se rompió el self-update legítimo: ' || SQLERRM;
    END IF;
  END;

  -- VÍA LEGÍTIMA 1 — un admin (desde la app, su JWT) cambia el status: SÍ debe
  IF v_auth_admin IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_admin)::text, true);
    BEGIN
      UPDATE usuarios SET status = v_status_nuevo WHERE id = v_id_miembro;
      v_r_legit_admin := '✅ PASS — el admin sí puede cambiar el status';
      RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
      ELSE v_r_legit_admin := '❌ FAIL — se bloqueó al admin: ' || SQLERRM;
      END IF;
    END;
  END IF;

  RESET ROLE;

  -- VÍA LEGÍTIMA 2 — service_role (Netlify Functions / webhook Stripe): SÍ debe
  SET LOCAL ROLE service_role;
  BEGIN
    UPDATE usuarios SET status = v_status_nuevo WHERE id = v_id_miembro;
    v_r_legit_srv := '✅ PASS — service_role sí puede cambiar el status';
    RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
    ELSE v_r_legit_srv := '❌ FAIL — se bloqueó a service_role: ' || SQLERRM;
    END IF;
  END;
  RESET ROLE;

  -- Insertar todos los resultados (ya como rol de la sesión).
  INSERT INTO _sec_fix_resultado (area, caso, resultado) VALUES
    ('C2', 'Miembro NO puede cambiar su rol',             v_r_rol),
    ('C2', 'Miembro NO puede cambiar su status',          v_r_status),
    ('C2', 'Miembro NO puede cambiar su tenant_id',       v_r_tenant),
    ('C2', 'Miembro NO puede cambiar su membresia_tier',  v_r_tier),
    ('C2', 'Miembro NO puede cambiar su no_shows_count',  v_r_noshows),
    ('C2', 'Miembro NO puede cambiar su bloqueado_hasta', v_r_bloq),
    ('C2', 'Miembro SÍ puede editar su teléfono',         v_r_tel),
    ('C2', 'Admin SÍ puede cambiar el status (legítimo)', v_r_legit_admin),
    ('C2', 'service_role SÍ puede cambiar el status (legítimo)', v_r_legit_srv);
END $$;


-- ////////////////////////////////////////////////////////////////////////////
-- RESULTADO
-- ////////////////////////////////////////////////////////////////////////////
SELECT area, caso, resultado FROM _sec_fix_resultado ORDER BY id;

-- ============================================================================
-- Notas:
--  - C1 (fake-signup) se cubre en src/__tests__/fake-signup.test.ts.
--  - H4 (logs de password) — verificado: las funciones no loguean el password.
--  - H6 (QR_JWT_SECRET) — verificar el valor en las env vars de Netlify prod.
-- ============================================================================
