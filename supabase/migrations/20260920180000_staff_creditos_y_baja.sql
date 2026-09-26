-- ============================================================================
-- Dos acciones de mostrador que solo se resolvían con SQL o en el dashboard de
-- Stripe: ajustar créditos y dar de baja una membresía
-- ============================================================================
-- M13 · `staff_ajustar_creditos`. Se cayó la luz a media sesión, falló el equipo,
--   una cortesía, un reembolso hecho en Stripe: no había forma de devolver o
--   quitar un crédito salvo `UPDATE membresias SET creditos_restantes = …` por la
--   policy `membresias_admin_all`, que descuadra el ledger y no deja rastro.
--   Ahora: motivo obligatorio, asiento `ajuste` en `membresia_movimientos`,
--   `audit_log` y aviso al miembro. El saldo nunca baja de 0 y un solo ajuste no
--   mueve más de 50 créditos (un dedazo no regala 500).
--
-- M14 · `staff_cancelar_membresia`. EKKO es mes a mes: "me quiero dar de baja" es
--   una petición de mostrador, y las functions de cancelar solo aceptaban el JWT
--   del propio miembro. La parte de Stripe la hace la function
--   `staff-cancelar-membresia`; esta RPC deja el estado, el asiento y el rastro:
--     · p_inmediata = false → queda `cancel_at_period_end`: conserva el acceso
--       hasta el fin de lo que ya pagó (con suscripción Stripe).
--     · p_inmediata = true  → se cierra ya (mostrador sin Stripe, o en pausa).
--       Los créditos que le quedaran se asientan como salida, no desaparecen.
--
-- Tests conductuales: src/__tests__/db/staff-membresia.db.test.ts
-- ============================================================================

CREATE OR REPLACE FUNCTION staff_ajustar_creditos(p_usuario_id uuid, p_delta integer, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_usuario usuarios;
  v_mem membresias;
  v_nuevo integer;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden ajustar créditos';
  END IF;
  IF COALESCE(length(trim(p_motivo)), 0) < 5 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Indica el motivo del ajuste';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 50 THEN
    RAISE EXCEPTION 'EKKO_AJUSTE_INVALIDO: El ajuste debe ser de 1 a 50 créditos, a favor o en contra';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  SELECT * INTO v_mem FROM membresias
  WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due', 'pausada')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: El miembro no tiene un plan vigente al que ajustarle créditos';
  END IF;
  IF v_mem.creditos_restantes IS NULL THEN
    RAISE EXCEPTION 'EKKO_PLAN_SIN_CREDITOS: Su plan es por tiempo (acceso ilimitado): no usa créditos';
  END IF;

  v_nuevo := v_mem.creditos_restantes + p_delta;
  IF v_nuevo < 0 THEN
    RAISE EXCEPTION 'EKKO_AJUSTE_INVALIDO: Solo le quedan % crédito(s); no se pueden quitar %', v_mem.creditos_restantes, abs(p_delta);
  END IF;

  UPDATE membresias SET creditos_restantes = v_nuevo, updated_at = now() WHERE id = v_mem.id;

  INSERT INTO membresia_movimientos (tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo)
  VALUES (v_tenant, v_mem.id, p_usuario_id, 'ajuste', p_delta, v_nuevo, 'Ajuste de recepción: ' || trim(p_motivo));

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'creditos_ajustados', 'usuario', p_usuario_id,
          jsonb_build_object('creditos_restantes', v_mem.creditos_restantes),
          jsonb_build_object('creditos_restantes', v_nuevo),
          trim(p_motivo), jsonb_build_object('membresia_id', v_mem.id, 'delta', p_delta));

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (v_tenant, p_usuario_id, 'creditos_ajustados',
          CASE WHEN p_delta > 0 THEN 'Te abonamos créditos' ELSE 'Ajustamos tus créditos' END,
          CASE WHEN p_delta > 0
               THEN 'Te abonamos ' || p_delta || ' crédito' || CASE WHEN p_delta = 1 THEN '' ELSE 's' END || '. Tu saldo es de ' || v_nuevo || '.'
               ELSE 'Se descontaron ' || abs(p_delta) || ' crédito' || CASE WHEN abs(p_delta) = 1 THEN '' ELSE 's' END || ' de tu saldo. Ahora tienes ' || v_nuevo || '.' END,
          jsonb_build_object('membresia_id', v_mem.id, 'delta', p_delta, 'url', '/app/perfil'));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id,
                            'creditos_antes', v_mem.creditos_restantes, 'creditos', v_nuevo);
END;
$$;

REVOKE ALL ON FUNCTION staff_ajustar_creditos(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_ajustar_creditos(uuid, integer, text) TO authenticated;


CREATE OR REPLACE FUNCTION staff_cancelar_membresia(p_usuario_id uuid, p_inmediata boolean, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_usuario usuarios;
  v_mem membresias;
  v_now timestamptz := now();
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden dar de baja una membresía';
  END IF;
  IF COALESCE(length(trim(p_motivo)), 0) < 5 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Indica el motivo de la baja';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  SELECT * INTO v_mem FROM membresias
  WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due', 'pausada')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que dar de baja';
  END IF;

  IF COALESCE(p_inmediata, false) THEN
    IF COALESCE(v_mem.creditos_restantes, 0) > 0 THEN
      INSERT INTO membresia_movimientos (tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo)
      VALUES (v_tenant, v_mem.id, p_usuario_id, 'ajuste', -v_mem.creditos_restantes, 0, 'Baja de la membresía: ' || trim(p_motivo));
    END IF;
    UPDATE membresias
    SET status = 'cancelada', cancelada_at = v_now, cancelada_efectiva_at = v_now,
        pausada_at = NULL,
        creditos_restantes = CASE WHEN creditos_restantes IS NULL THEN NULL ELSE 0 END,
        updated_at = v_now
    WHERE id = v_mem.id;
    UPDATE usuarios
    SET status = 'cancelado', membresia_activa_id = NULL, membresia_tier = NULL
    WHERE id = p_usuario_id;
  ELSE
    UPDATE membresias SET cancel_at_period_end = true, updated_at = v_now WHERE id = v_mem.id;
  END IF;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'membresia_baja', 'usuario', p_usuario_id,
          jsonb_build_object('membresia_status', v_mem.status, 'usuario_status', v_usuario.status,
                             'creditos_restantes', v_mem.creditos_restantes),
          jsonb_build_object('membresia_status', CASE WHEN COALESCE(p_inmediata, false) THEN 'cancelada' ELSE v_mem.status END,
                             'cancel_at_period_end', NOT COALESCE(p_inmediata, false)),
          trim(p_motivo),
          jsonb_build_object('membresia_id', v_mem.id, 'inmediata', COALESCE(p_inmediata, false),
                             'stripe_subscription_id', v_mem.stripe_subscription_id));

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (v_tenant, p_usuario_id, 'membresia_baja', 'Tu membresía se dio de baja',
          CASE WHEN COALESCE(p_inmediata, false)
               THEN 'Dimos de baja tu membresía. Cuando quieras volver, elige un plan desde tu perfil.'
               ELSE 'Tu membresía no se renovará. Conservas tu acceso hasta el fin del periodo que ya pagaste.' END,
          jsonb_build_object('membresia_id', v_mem.id, 'url', '/app/perfil'));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id,
                            'inmediata', COALESCE(p_inmediata, false),
                            'stripe_subscription_id', v_mem.stripe_subscription_id,
                            'periodo_actual_fin', v_mem.periodo_actual_fin);
END;
$$;

REVOKE ALL ON FUNCTION staff_cancelar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_cancelar_membresia(uuid, boolean, text) TO authenticated;
