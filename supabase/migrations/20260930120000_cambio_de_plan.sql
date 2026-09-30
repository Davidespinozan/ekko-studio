-- ============================================================================
-- PKG-01F · Cambio de plan mensual → mensual: guard de reservas + transición atómica
-- ============================================================================
-- Hasta hoy `cambiar-plan-suscripcion` hacía el `subscriptions.update` en Stripe
-- y después dos UPDATE sueltos (membresias.tier_id, usuarios.membresia_tier)
-- sin transacción, sin lock, sin idempotencia y sin ninguna evidencia: no se
-- podía reconstruir qué plan tenía el miembro ni cuándo pidió cambiar (C10).
-- Y ninguna capa revisaba si el plan destino dejaba inválidas reservas ya
-- hechas (D12).
--
-- Dos primitivas, ambas SECURITY DEFINER y solo service_role:
--
--   reservas_incompatibles_con_tier(usuario, tier)
--     Lectura: reservas futuras confirmadas del miembro que el tier destino no
--     permitiría hoy (estudio fuera de `tiers_permitidos` o más invitados que
--     `reglas.max_invitados`). NO cancela ni modifica nada; solo diagnóstico.
--
--   cambiar_tier_membresia(operation_id, usuario, membresia, tier, sub, resumen, actor)
--     Transición de tier de UNA membresía viva, atómica e idempotente por
--     operation_id (lock transaccional + relectura del audit): actualiza
--     membresias.tier_id y usuarios.membresia_tier juntos y deja en audit_log
--     el tier anterior → destino con la referencia de Stripe y el resumen
--     económico devuelto por Stripe. NO llama a activar_membresia, NO crea una
--     segunda membresía, NO toca R1 ni el webhook.
--
-- Tests conductuales: src/__tests__/db/cambio-de-plan.db.test.ts
-- ============================================================================

-- ----------------------------------------------------------------------------
-- reservas_incompatibles_con_tier
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reservas_incompatibles_con_tier(p_usuario_id uuid, p_tier_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_tier tiers;
  v_max_invitados integer;
  v_lista jsonb;
BEGIN
  SELECT * INTO v_tier FROM tiers WHERE id = p_tier_id;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan no encontrado';
  END IF;
  -- Misma regla que reservar_recurso_atomic: reglas.max_invitados del plan;
  -- sin regla explícita, el default histórico (2). NULL en reglas = sin tope.
  v_max_invitados := COALESCE((v_tier.reglas->>'max_invitados')::integer, 2);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'reserva_id', r.id,
           'folio', r.folio,
           'slot_inicio', r.slot_inicio,
           'recurso', rc.nombre,
           'invitados', r.invitados_count,
           'motivo', CASE WHEN NOT _recurso_permite_tier(rc.tiers_permitidos, v_tier.slug)
                          THEN 'estudio_no_permitido' ELSE 'invitados_exceden' END
         ) ORDER BY r.slot_inicio), '[]'::jsonb)
    INTO v_lista
  FROM reservas r
  JOIN recursos rc ON rc.id = r.recurso_id
  WHERE r.usuario_id = p_usuario_id
    AND r.status = 'confirmada'
    AND r.slot_inicio > now()
    AND (
      NOT _recurso_permite_tier(rc.tiers_permitidos, v_tier.slug)
      OR r.invitados_count > v_max_invitados
    );

  RETURN v_lista;
END;
$$;

REVOKE EXECUTE ON FUNCTION reservas_incompatibles_con_tier(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reservas_incompatibles_con_tier(uuid, uuid) TO service_role;

-- ----------------------------------------------------------------------------
-- cambiar_tier_membresia
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cambiar_tier_membresia(
  p_operation_id uuid,
  p_usuario_id uuid,
  p_membresia_id uuid,
  p_tier_destino uuid,
  p_stripe_subscription_id text,
  p_resumen jsonb DEFAULT '{}'::jsonb,
  p_actor_usuario_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usuario usuarios;
  v_mem membresias;
  v_tier_anterior tiers;
  v_tier_destino tiers;
  v_previo audit_log;
  v_actor_rol text;
  v_now timestamptz := now();
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INVALIDA: operation_id requerido';
  END IF;

  -- CLAIM: dos requests del mismo cambio se serializan aquí.
  PERFORM pg_advisory_xact_lock(hashtextextended('cambio_plan:' || p_operation_id::text, 0));

  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado';
  END IF;
  -- R1 manda: una cuenta revocada o sancionada no cambia de plan.
  IF v_usuario.status = 'revocado' OR v_usuario.sancionado_at IS NOT NULL THEN
    RAISE EXCEPTION 'EKKO_CUENTA_RESTRINGIDA: La cuenta está revocada o sancionada';
  END IF;

  SELECT * INTO v_tier_destino
  FROM tiers WHERE id = p_tier_destino AND tenant_id = v_usuario.tenant_id AND activo = true;
  IF v_tier_destino.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan destino no encontrado o inactivo';
  END IF;
  IF v_tier_destino.tipo <> 'tiempo' THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Solo se cambia entre planes mensuales';
  END IF;

  -- REPLAY: esta operación ya se aplicó → misma respuesta, sin segundo efecto.
  SELECT * INTO v_previo
  FROM audit_log
  WHERE accion = 'plan_cambiado'
    AND target_id = p_usuario_id
    AND metadata->>'operation_id' = p_operation_id::text
  ORDER BY creada_at DESC
  LIMIT 1;
  IF v_previo.id IS NOT NULL THEN
    IF (v_previo.metadata->>'membresia_id')::uuid <> p_membresia_id
       OR (v_previo.despues->>'tier_id')::uuid <> p_tier_destino THEN
      RAISE EXCEPTION 'EKKO_OPERACION_CONFLICTO: El operation_id ya corresponde a otro cambio de plan';
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'idempotente', true,
      'membresia_id', p_membresia_id,
      'tier_anterior', v_previo.antes->>'tier_slug',
      'tier', v_tier_destino.slug
    );
  END IF;

  -- EXECUTE ONCE
  SELECT * INTO v_mem FROM membresias WHERE id = p_membresia_id FOR UPDATE;
  IF v_mem.id IS NULL OR v_mem.usuario_id <> p_usuario_id THEN
    RAISE EXCEPTION 'EKKO_MEMBRESIA_INVALIDA: La membresía no es de este miembro';
  END IF;
  IF v_mem.status <> 'activa' THEN
    RAISE EXCEPTION 'EKKO_MEMBRESIA_NO_ACTIVA: La membresía no está activa (%)', v_mem.status;
  END IF;
  IF v_mem.stripe_subscription_id IS NULL OR v_mem.stripe_subscription_id <> p_stripe_subscription_id THEN
    RAISE EXCEPTION 'EKKO_SUSCRIPCION_INVALIDA: La suscripción no corresponde a la membresía';
  END IF;

  SELECT * INTO v_tier_anterior FROM tiers WHERE id = v_mem.tier_id;

  UPDATE membresias
  SET tier_id = p_tier_destino, updated_at = v_now
  WHERE id = v_mem.id;

  UPDATE usuarios
  SET membresia_tier = v_tier_destino.slug
  WHERE id = p_usuario_id;

  v_actor_rol := CASE WHEN p_actor_usuario_id IS NULL THEN 'sistema'
                      ELSE (SELECT rol FROM usuarios WHERE id = p_actor_usuario_id) END;

  -- Evidencia durable, en la MISMA transacción que la transición.
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
  VALUES (
    v_usuario.tenant_id, p_actor_usuario_id, COALESCE(v_actor_rol, 'sistema'), 'plan_cambiado', 'usuario', p_usuario_id,
    jsonb_build_object('tier_id', v_mem.tier_id, 'tier_slug', v_tier_anterior.slug,
                       'precio_centavos', v_tier_anterior.precio_centavos),
    jsonb_build_object('tier_id', p_tier_destino, 'tier_slug', v_tier_destino.slug,
                       'precio_centavos', v_tier_destino.precio_centavos),
    jsonb_build_object('operation_id', p_operation_id, 'membresia_id', v_mem.id,
                       'stripe_subscription_id', p_stripe_subscription_id,
                       'stripe', COALESCE(p_resumen, '{}'::jsonb))
  );

  RETURN jsonb_build_object(
    'success', true, 'idempotente', false,
    'membresia_id', v_mem.id,
    'tier_anterior', v_tier_anterior.slug,
    'tier', v_tier_destino.slug
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION cambiar_tier_membresia(uuid, uuid, uuid, uuid, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cambiar_tier_membresia(uuid, uuid, uuid, uuid, text, jsonb, uuid) TO service_role;
