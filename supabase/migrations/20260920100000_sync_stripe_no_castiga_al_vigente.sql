-- ============================================================================
-- sync_membresia_stripe: cancelar una suscripción VIEJA no castiga al miembro
-- ============================================================================
-- Bug (SALA_PARITY_AUDIT_2 · P0-1): al cambiar de plan o comprar un paquete con
-- una mensualidad viva, el webhook cancela la suscripción anterior en Stripe →
-- Stripe emite `customer.subscription.deleted` de ESA sub → esta función ponía
-- `usuarios.status='cancelado', membresia_activa_id=NULL` sin mirar si el
-- miembro ya tenía OTRA membresía viva. Resultado: quien acababa de pagar
-- quedaba sin acceso (en mensual se autocuraba con el siguiente invoice.paid;
-- en paquete, nunca).
--
-- Además, 20260821200000 recreó la función desde un cuerpo viejo y perdió el
-- `membresia_tier = NULL` de 20260704230000 (cancelado conserva el tier y no
-- puede recomprar el mismo plan).
--
-- Fix: la rama 'cancelada' solo toca `usuarios` si el miembro NO tiene otra
-- membresía viva (trialing/activa/past_due/pausada); y vuelve a soltar el tier.
--
-- M5: la rama 'activa'/'past_due' ya no revive a un miembro suspendido o
-- revocado por el admin (un cobro no levanta una sanción).
--
-- Cuerpo copiado de la definición vigente (20260821200000:100-172); solo cambian
-- esas dos ramas. Tests conductuales: src/__tests__/db/dinero-y-acceso.db.test.ts (baja de
-- sub vieja) y membresias-dinero.db.test.ts (M5).
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_membresia_stripe(
  p_stripe_subscription_id text,
  p_estado text,
  p_periodo_fin timestamptz DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT NULL,
  p_event_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem membresias;
  v_now timestamptz := now();
  v_new_status text;
  v_otra_viva boolean;
BEGIN
  SELECT * INTO v_mem
  FROM membresias
  WHERE stripe_subscription_id = p_stripe_subscription_id;

  IF v_mem.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'membresia_no_encontrada');
  END IF;

  -- Guardia de orden: ignorar eventos más viejos que el último aplicado.
  IF p_event_at IS NOT NULL
     AND v_mem.last_sub_event_at IS NOT NULL
     AND p_event_at <= v_mem.last_sub_event_at THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'evento_viejo');
  END IF;

  v_new_status := CASE p_estado
    WHEN 'activa'    THEN 'activa'
    WHEN 'past_due'  THEN 'past_due'
    WHEN 'pausada'   THEN 'pausada'
    WHEN 'cancelada' THEN 'cancelada'
    ELSE v_mem.status
  END;

  UPDATE membresias SET
    status                = v_new_status,
    periodo_actual_fin    = COALESCE(p_periodo_fin, periodo_actual_fin),
    cancel_at_period_end  = COALESCE(p_cancel_at_period_end, cancel_at_period_end),
    pausada_at            = CASE WHEN v_new_status = 'pausada' THEN COALESCE(pausada_at, v_now)
                                 WHEN v_new_status = 'activa' THEN NULL ELSE pausada_at END,
    cancelada_at          = CASE WHEN v_new_status = 'cancelada'
                                 THEN COALESCE(cancelada_at, v_now) ELSE cancelada_at END,
    cancelada_efectiva_at = CASE WHEN v_new_status = 'cancelada'
                                 THEN v_now ELSE cancelada_efectiva_at END,
    last_sub_event_at     = COALESCE(p_event_at, v_now),
    updated_at            = v_now
  WHERE id = v_mem.id;

  -- Acceso del miembro (la app gatea por usuarios.status):
  --   activa/past_due → acceso (past_due es GRACIA mientras Stripe reintenta).
  --   pausada         → suspendido (sin reservas, sin cobro).
  --   cancelada       → corta acceso y suelta la membresía y el tier, PERO solo
  --                     si esta era su membresía vigente: la baja de una sub
  --                     vieja (cambio de plan) no toca al miembro.
  IF v_new_status IN ('activa', 'past_due') THEN
    -- Un cobro NO levanta una sanción. Antes era `status <> 'activo'`: el
    -- invoice.paid del día 1 le devolvía el acceso a un miembro que el admin
    -- había suspendido o revocado. Se reactiva a quien estaba sin acceso por
    -- PAGO (cancelado / pendiente_*) y a quien estaba suspendido por la PAUSA de
    -- esta misma membresía (v_mem es la fila de antes del UPDATE).
    UPDATE usuarios SET status = 'activo'
    WHERE id = v_mem.usuario_id
      AND (status IN ('cancelado', 'pendiente_pago', 'pendiente_onboarding')
           OR (status = 'suspendido' AND v_mem.status = 'pausada'));
  ELSIF v_new_status = 'pausada' THEN
    UPDATE usuarios SET status = 'suspendido'
    WHERE id = v_mem.usuario_id AND status = 'activo';
  ELSIF v_new_status = 'cancelada' THEN
    SELECT EXISTS (
      SELECT 1 FROM membresias
      WHERE usuario_id = v_mem.usuario_id
        AND id <> v_mem.id
        AND status IN ('trialing', 'activa', 'past_due', 'pausada')
    ) INTO v_otra_viva;

    IF v_otra_viva THEN
      RETURN jsonb_build_object(
        'success', true, 'estado', v_new_status, 'membresia_id', v_mem.id,
        'usuario_intacto', true
      );
    END IF;

    UPDATE usuarios
    SET status = 'cancelado', membresia_activa_id = NULL, membresia_tier = NULL
    WHERE id = v_mem.usuario_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'estado', v_new_status, 'membresia_id', v_mem.id);
END;
$$;

REVOKE EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) TO service_role;
