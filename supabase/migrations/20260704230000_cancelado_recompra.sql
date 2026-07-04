-- ============================================================================
-- Recompra self-serve tras cancelar: limpiar membresia_tier al cancelar
-- ----------------------------------------------------------------------------
-- Cuando una suscripción termina, sync_membresia_stripe ponía status='cancelado'
-- y membresia_activa_id=NULL, pero DEJABA membresia_tier con el plan viejo. En el
-- modal "Ver planes" el plan marcado como "Actual" NO tiene botón "Elegir este"
-- → un miembro cancelado no podía RECOMPRAR su mismo plan.
--
-- Ahora al cancelar también se nulea membresia_tier: la app le muestra "sin plan"
-- limpio y puede elegir/pagar cualquier plan (incluido el que tenía). El gate de
-- entrada ya permite a 'cancelado' entrar a recomprar (validarStatusCuenta).
--
-- CREATE OR REPLACE del cuerpo vigente (20260620120000) — único cambio: la rama
-- 'cancelada' nulea membresia_tier. Los grants se preservan.
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
BEGIN
  SELECT * INTO v_mem
  FROM membresias
  WHERE stripe_subscription_id = p_stripe_subscription_id;

  IF v_mem.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'membresia_no_encontrada');
  END IF;

  IF p_event_at IS NOT NULL
     AND v_mem.last_sub_event_at IS NOT NULL
     AND p_event_at <= v_mem.last_sub_event_at THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'evento_viejo');
  END IF;

  v_new_status := CASE p_estado
    WHEN 'activa'    THEN 'activa'
    WHEN 'past_due'  THEN 'past_due'
    WHEN 'cancelada' THEN 'cancelada'
    ELSE v_mem.status
  END;

  UPDATE membresias SET
    status                = v_new_status,
    periodo_actual_fin    = COALESCE(p_periodo_fin, periodo_actual_fin),
    cancel_at_period_end  = COALESCE(p_cancel_at_period_end, cancel_at_period_end),
    cancelada_at          = CASE WHEN v_new_status = 'cancelada'
                                 THEN COALESCE(cancelada_at, v_now) ELSE cancelada_at END,
    cancelada_efectiva_at = CASE WHEN v_new_status = 'cancelada'
                                 THEN v_now ELSE cancelada_efectiva_at END,
    last_sub_event_at     = COALESCE(p_event_at, v_now),
    updated_at            = v_now
  WHERE id = v_mem.id;

  IF v_new_status IN ('activa', 'past_due') THEN
    UPDATE usuarios SET status = 'activo'
    WHERE id = v_mem.usuario_id AND status <> 'activo';
  ELSIF v_new_status = 'cancelada' THEN
    -- Suelta la membresía Y el tier viejo → la app muestra "sin plan" y puede
    -- recomprar CUALQUIER plan (incluido el que tenía).
    UPDATE usuarios SET status = 'cancelado', membresia_activa_id = NULL, membresia_tier = NULL
    WHERE id = v_mem.usuario_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'estado', v_new_status, 'membresia_id', v_mem.id);
END;
$$;
