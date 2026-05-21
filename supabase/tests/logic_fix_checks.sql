-- ============================================================================
-- LOGIC-FIX — Verificación de los fixes de lógica (L-01, L-02, L-03)
-- ============================================================================
-- Cómo usar:
--   1. Aplicá la migración 20260522100000_logic_fix.sql.
--   2. Pegá TODO este archivo en el SQL editor de Supabase (EKKO) y ejecutá.
--      Tal cual — no hay nada que reemplazar.
--
-- Resultado: una TABLA al final con area · caso · resultado (✅/❌/⚠️/⏭).
-- Ninguna mutación de prueba persiste (patrón EKKO_TEST_ROLLBACK de SEC-FIX).
--
-- Cubre: L-01 (timezone en horario), L-02 (check-in rechaza cancelada_admin),
-- L-03 (revocado en el CHECK de usuarios.status).
-- ============================================================================

DROP TABLE IF EXISTS _logic_fix_resultado;
CREATE TEMP TABLE _logic_fix_resultado (
  id serial PRIMARY KEY,
  area text,
  caso text,
  resultado text
);


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 1 — Checks estructurales (la migración se aplicó)
-- ////////////////////////////////////////////////////////////////////////////
DO $$
DECLARE
  v_def text;
BEGIN
  -- L-03 — el CHECK de usuarios.status admite 'revocado'
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint WHERE conname = 'usuarios_status_check';
  INSERT INTO _logic_fix_resultado (area, caso, resultado) VALUES
    ('L-03', 'CHECK de usuarios.status admite ''revocado''',
     CASE WHEN v_def LIKE '%revocado%' THEN '✅ PASS'
          ELSE '❌ FAIL — el CHECK no incluye revocado' END);

  -- L-01 — reservar_recurso_atomic ancla el horario a America/Mazatlan
  SELECT pg_get_functiondef('reservar_recurso_atomic'::regproc) INTO v_def;
  INSERT INTO _logic_fix_resultado (area, caso, resultado) VALUES
    ('L-01', 'reservar_recurso_atomic valida horario en hora de Culiacán',
     CASE WHEN v_def LIKE '%America/Mazatlan%' THEN '✅ PASS'
          ELSE '❌ FAIL — el RPC no ancla la timezone' END);

  -- L-02 — ambas funciones de check-in tienen el catch-all negativo
  SELECT pg_get_functiondef('check_in_atomic'::regproc) INTO v_def;
  INSERT INTO _logic_fix_resultado (area, caso, resultado) VALUES
    ('L-02', 'check_in_atomic rechaza estados no-confirmada',
     CASE WHEN v_def LIKE '%EKKO_RESERVA_NO_CHECKINEABLE%'
               AND v_def LIKE '%cancelada_admin%' THEN '✅ PASS'
          ELSE '❌ FAIL — falta el check robusto de estado' END);

  SELECT pg_get_functiondef('check_in_manual_atomic'::regproc) INTO v_def;
  INSERT INTO _logic_fix_resultado (area, caso, resultado) VALUES
    ('L-02', 'check_in_manual_atomic rechaza estados no-confirmada',
     CASE WHEN v_def LIKE '%EKKO_RESERVA_NO_CHECKINEABLE%'
               AND v_def LIKE '%cancelada_admin%' THEN '✅ PASS'
          ELSE '❌ FAIL — falta el check robusto de estado' END);
END $$;


-- ////////////////////////////////////////////////////////////////////////////
-- PARTE 2 — Checks de comportamiento
-- ////////////////////////////////////////////////////////////////////////////
DO $$
DECLARE
  v_tenant         uuid;
  v_auth_recepcion uuid;
  v_recurso        uuid;
  v_miembro        uuid;
  v_reserva_id     uuid;
  v_id_usuario     uuid;
  v_res            text;
BEGIN
  -- L-03 comportamiento — un UPDATE a status='revocado' NO debe violar el CHECK
  SELECT id INTO v_id_usuario
  FROM usuarios WHERE rol IN ('recepcionista', 'staff', 'admin')
  ORDER BY created_at LIMIT 1;

  IF v_id_usuario IS NULL THEN
    v_res := '⏭ SKIP — no hay usuario de staff para probar';
  ELSE
    BEGIN
      UPDATE usuarios SET status = 'revocado' WHERE id = v_id_usuario;
      v_res := '✅ PASS — status=''revocado'' aceptado por el CHECK';
      RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
      ELSE v_res := '❌ FAIL — el CHECK rechazó revocado: ' || SQLERRM;
      END IF;
    END;
  END IF;
  INSERT INTO _logic_fix_resultado (area, caso, resultado)
  VALUES ('L-03', 'UPDATE status=''revocado'' no viola el CHECK', v_res);

  -- L-02 comportamiento — check_in_atomic rechaza una reserva cancelada_admin
  SELECT u.auth_id, u.tenant_id INTO v_auth_recepcion, v_tenant
  FROM usuarios u WHERE u.rol = 'recepcionista' AND u.auth_id IS NOT NULL
  ORDER BY u.created_at LIMIT 1;

  SELECT id INTO v_recurso FROM recursos
  WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;

  SELECT id INTO v_miembro FROM usuarios
  WHERE rol = 'miembro' AND tenant_id = v_tenant ORDER BY created_at LIMIT 1;

  IF v_auth_recepcion IS NULL OR v_recurso IS NULL OR v_miembro IS NULL THEN
    v_res := '⏭ SKIP — falta recepcionista / recurso / miembro de prueba';
  ELSE
    BEGIN
      -- Insertar una reserva ya cancelada por el estudio.
      INSERT INTO reservas (
        tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
        duracion_min, invitados_count, status, folio
      ) VALUES (
        v_tenant, v_recurso, v_miembro,
        now() + interval '50 hours', now() + interval '51 hours',
        60, 0, 'cancelada_admin', 'LOGICFIX-TEST'
      ) RETURNING id INTO v_reserva_id;

      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', v_auth_recepcion)::text, true);
      PERFORM check_in_atomic(v_reserva_id);

      v_res := '❌ FAIL — check-in aceptó una reserva cancelada_admin';
      RAISE EXCEPTION 'EKKO_TEST_ROLLBACK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'EKKO_TEST_ROLLBACK' THEN NULL;
      ELSIF SQLERRM LIKE '%EKKO_RESERVA_CANCELADA%' THEN
        v_res := '✅ PASS — check-in rechazó la reserva cancelada_admin';
      ELSE
        v_res := '⚠️ WARN — rechazado por otro error: ' || SQLERRM;
      END IF;
    END;
  END IF;
  INSERT INTO _logic_fix_resultado (area, caso, resultado)
  VALUES ('L-02', 'check_in_atomic rechaza una reserva cancelada_admin', v_res);
END $$;


-- ////////////////////////////////////////////////////////////////////////////
-- RESULTADO
-- ////////////////////////////////////////////////////////////////////////////
SELECT area, caso, resultado FROM _logic_fix_resultado ORDER BY id;

-- ============================================================================
-- Nota — L-01 (timezone) conviene además probarlo manualmente: reservar desde
-- la app de miembro un slot de las 18:00 hora Culiacán. Antes del fix, con
-- sesión Postgres en UTC, se rechazaba con EKKO_FUERA_DE_HORARIO; ahora debe
-- aceptarse.
-- ============================================================================
