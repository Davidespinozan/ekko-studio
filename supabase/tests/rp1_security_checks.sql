-- ============================================================================
-- RP-1 — Validación de seguridad de los RPCs (Recepción Plus)
-- ============================================================================
-- Cómo usar:
--   1. Aplicá primero la migración 20260520100000_recepcion_plus_rp1.sql.
--   2. Pegá TODO este archivo en el SQL editor de Supabase (EKKO, no SALA)
--      y ejecutá. Tal cual — no hay nada que reemplazar.
--
-- Qué hace: descubre solo las cuentas de prueba (recepción, miembro, recurso),
-- simula la sesión de cada rol con set_config('request.jwt.claims', ...) y
-- corre los 8 casos. Imprime ✅ PASS / ❌ FAIL por cada uno en los NOTICE.
-- Todo va dentro de BEGIN/ROLLBACK → no persiste ninguna reserva de prueba.
--
-- Si un bloque no encuentra datos (ej. no hay miembro suspendido, o un solo
-- tenant) lo informa como ⚠️ SKIP, no como fallo.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_tenant            uuid;
  v_auth_recepcion    uuid;
  v_usuario_recepcion uuid;
  v_auth_miembro      uuid;
  v_usuario_activo    uuid;
  v_auth_miembro2     uuid;
  v_recurso           uuid;
  v_usuario_noactivo  uuid;
  v_usuario_otro_tnt  uuid;
  v_result            jsonb;
  v_status            text;
  v_cancelada_por     uuid;
  v_notifs            integer;
  v_r6 uuid; v_r7 uuid; v_r8 uuid;
BEGIN
  -- ===== DESCUBRIR DATOS DE PRUEBA ==========================================
  SELECT u.auth_id, u.id, u.tenant_id
    INTO v_auth_recepcion, v_usuario_recepcion, v_tenant
  FROM usuarios u
  WHERE u.rol = 'recepcionista' AND u.auth_id IS NOT NULL
  ORDER BY u.created_at LIMIT 1;

  IF v_auth_recepcion IS NULL THEN
    RAISE NOTICE 'ABORT — no hay cuenta recepcionista con auth_id. Creá una primero.';
    RETURN;
  END IF;

  SELECT id, auth_id INTO v_usuario_activo, v_auth_miembro
  FROM usuarios
  WHERE rol = 'miembro' AND status = 'activo' AND tenant_id = v_tenant
    AND auth_id IS NOT NULL
  ORDER BY created_at LIMIT 1;

  SELECT id INTO v_recurso
  FROM recursos WHERE activo AND tenant_id = v_tenant
  ORDER BY created_at LIMIT 1;

  IF v_usuario_activo IS NULL OR v_recurso IS NULL THEN
    RAISE NOTICE 'ABORT — falta un miembro activo o un recurso activo en el tenant.';
    RETURN;
  END IF;

  SELECT auth_id INTO v_auth_miembro2
  FROM usuarios
  WHERE rol = 'miembro' AND tenant_id = v_tenant AND auth_id IS NOT NULL
    AND id <> v_usuario_activo
  LIMIT 1;

  SELECT id INTO v_usuario_noactivo
  FROM usuarios
  WHERE rol = 'miembro' AND status <> 'activo' AND tenant_id = v_tenant
  LIMIT 1;

  SELECT id INTO v_usuario_otro_tnt
  FROM usuarios WHERE tenant_id <> v_tenant LIMIT 1;

  RAISE NOTICE '--- tenant=%  recepción=%  miembro=%  recurso=% ---',
    v_tenant, v_usuario_recepcion, v_usuario_activo, v_recurso;

  -- ===== reservar_para_miembro_atomic =======================================

  -- ✅ CASO 1 — recepción reserva para un miembro activo
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_recepcion)::text, true);
  BEGIN
    v_result := reservar_para_miembro_atomic(
      v_usuario_activo, v_recurso, now() + interval '100 hours', 60, 0, 'rp1-c1');
    IF (v_result->>'success')::boolean THEN
      RAISE NOTICE 'CASO 1 ✅ PASS — reserva creada (folio %)', v_result->>'folio';
    ELSE
      RAISE NOTICE 'CASO 1 ❌ FAIL — no devolvió success: %', v_result;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CASO 1 ❌ FAIL — esperaba OK, error: %', SQLERRM;
  END;

  -- ❌ CASO 2 — un miembro llama el RPC → debe ser bloqueado
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_miembro)::text, true);
  BEGIN
    v_result := reservar_para_miembro_atomic(
      v_usuario_activo, v_recurso, now() + interval '102 hours', 60, 0, NULL);
    RAISE NOTICE 'CASO 2 ❌ FAIL — un miembro pudo reservar para otro';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%'
      THEN RAISE NOTICE 'CASO 2 ✅ PASS — miembro bloqueado';
      ELSE RAISE NOTICE 'CASO 2 ⚠️  bloqueado pero por otro error: %', SQLERRM;
    END IF;
  END;

  -- ❌ CASO 3 — recepción reserva para un miembro de OTRO tenant
  IF v_usuario_otro_tnt IS NULL THEN
    RAISE NOTICE 'CASO 3 ⚠️  SKIP — no hay miembros de otro tenant';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_recepcion)::text, true);
    BEGIN
      v_result := reservar_para_miembro_atomic(
        v_usuario_otro_tnt, v_recurso, now() + interval '104 hours', 60, 0, NULL);
      RAISE NOTICE 'CASO 3 ❌ FAIL — reservó cross-tenant';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%EKKO_MIEMBRO_INVALIDO%'
        THEN RAISE NOTICE 'CASO 3 ✅ PASS — cross-tenant bloqueado';
        ELSE RAISE NOTICE 'CASO 3 ⚠️  bloqueado pero por otro error: %', SQLERRM;
      END IF;
    END;
  END IF;

  -- ❌ CASO 4 — recepción reserva para un miembro no-activo (D2)
  IF v_usuario_noactivo IS NULL THEN
    RAISE NOTICE 'CASO 4 ⚠️  SKIP — no hay miembros no-activos para probar';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_recepcion)::text, true);
    BEGIN
      v_result := reservar_para_miembro_atomic(
        v_usuario_noactivo, v_recurso, now() + interval '106 hours', 60, 0, NULL);
      RAISE NOTICE 'CASO 4 ❌ FAIL — reservó para un miembro no-activo';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%EKKO_MIEMBRO_NO_ACTIVO%'
        THEN RAISE NOTICE 'CASO 4 ✅ PASS — miembro no-activo bloqueado';
        ELSE RAISE NOTICE 'CASO 4 ⚠️  bloqueado pero por otro error: %', SQLERRM;
      END IF;
    END;
  END IF;

  -- ✅ CASO 5 — walk-in: slot dentro de la ventana de anticipación (D1)
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_recepcion)::text, true);
  BEGIN
    v_result := reservar_para_miembro_atomic(
      v_usuario_activo, v_recurso, now() + interval '30 minutes', 60, 0, 'walk-in');
    IF (v_result->>'success')::boolean
      THEN RAISE NOTICE 'CASO 5 ✅ PASS — walk-in permitido (saltó anticipación)';
      ELSE RAISE NOTICE 'CASO 5 ❌ FAIL — %', v_result;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CASO 5 ❌ FAIL — esperaba OK, error: %', SQLERRM;
  END;

  -- ===== cancelar_reserva_atomic ============================================
  -- Reservas de prueba (INSERT directo, futuras, confirmadas).
  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                        duracion_min, folio, status, invitados_count)
  VALUES (v_tenant, v_recurso, v_usuario_activo, now() + interval '200 hours',
          now() + interval '201 hours', 60, 'RP1-T6', 'confirmada', 0)
  RETURNING id INTO v_r6;

  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                        duracion_min, folio, status, invitados_count)
  VALUES (v_tenant, v_recurso, v_usuario_activo, now() + interval '202 hours',
          now() + interval '203 hours', 60, 'RP1-T7', 'confirmada', 0)
  RETURNING id INTO v_r7;

  INSERT INTO reservas (tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin,
                        duracion_min, folio, status, invitados_count)
  VALUES (v_tenant, v_recurso, v_usuario_activo, now() + interval '204 hours',
          now() + interval '205 hours', 60, 'RP1-T8', 'confirmada', 0)
  RETURNING id INTO v_r8;

  -- ✅ CASO 6 — recepción cancela la reserva de un miembro
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_recepcion)::text, true);
  BEGIN
    SELECT status, cancelada_por INTO v_status, v_cancelada_por
    FROM cancelar_reserva_atomic(v_r6, 'rp1-c6');
    SELECT count(*) INTO v_notifs
    FROM notificaciones WHERE metadata->>'reserva_id' = v_r6::text;
    IF v_status = 'cancelada_admin' AND v_cancelada_por = v_usuario_recepcion
       AND v_notifs >= 1 THEN
      RAISE NOTICE 'CASO 6 ✅ PASS — cancelada_admin + cancelada_por + notificación';
    ELSE
      RAISE NOTICE 'CASO 6 ❌ FAIL — status=% cancelada_por=% notifs=%',
        v_status, v_cancelada_por, v_notifs;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CASO 6 ❌ FAIL — error: %', SQLERRM;
  END;

  -- ✅ CASO 7 — el propio miembro cancela su reserva → 'cancelada'
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_auth_miembro)::text, true);
  BEGIN
    SELECT status INTO v_status FROM cancelar_reserva_atomic(v_r7, NULL);
    IF v_status = 'cancelada'
      THEN RAISE NOTICE 'CASO 7 ✅ PASS — miembro propio → cancelada';
      ELSE RAISE NOTICE 'CASO 7 ❌ FAIL — status=% (esperaba cancelada)', v_status;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'CASO 7 ❌ FAIL — error: %', SQLERRM;
  END;

  -- ❌ CASO 8 — un miembro intenta cancelar la reserva de OTRO miembro
  IF v_auth_miembro2 IS NULL THEN
    RAISE NOTICE 'CASO 8 ⚠️  SKIP — no hay un segundo miembro con auth_id';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_auth_miembro2)::text, true);
    BEGIN
      PERFORM cancelar_reserva_atomic(v_r8, NULL);
      RAISE NOTICE 'CASO 8 ❌ FAIL — un miembro canceló reserva ajena';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%EKKO_NO_AUTORIZADO%'
        THEN RAISE NOTICE 'CASO 8 ✅ PASS — cancelación ajena bloqueada';
        ELSE RAISE NOTICE 'CASO 8 ⚠️  bloqueado pero por otro error: %', SQLERRM;
      END IF;
    END;
  END IF;

  RAISE NOTICE '--- RP-1 security checks finalizados (todo se revierte) ---';
END $$;

ROLLBACK;

-- ============================================================================
-- Regresión — lo prohibido sigue prohibido (verificación aparte, no en el DO):
--  - reception-create-member: cubierto por
--    src/__tests__/reception-create-member.test.ts (8 casos, automatizado).
--  - admin-create-user / admin-delete-user siguen devolviendo 403 a recepción.
--  - RLS de membresias / payment_events / tiers / tenants intacta (is_admin()).
--  - Recepción que abra /admin/* sigue rebotada por el guard de AdminLayout.
-- ============================================================================
