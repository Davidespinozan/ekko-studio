-- ============================================================================
-- Pausar / reanudar membresía (viajes, lesiones) desde el mostrador o admin
-- ============================================================================
-- Hoy un miembro "congelado" a mano seguía pagando (la suscripción de Stripe no
-- se tocaba) o había que cancelarlo. Nuevo estado `pausada` en membresias:
--   · staff_pausar_membresia(p_usuario_id, p_pausar, p_motivo): gate de rol
--     (admin/recepción) + tenant, cambia membresias.status (activa ⇄ pausada),
--     usuarios.status (activo ⇄ suspendido: sin reservas mientras dure), avisa
--     al miembro y deja audit_log. La function `stripe-pausar-membresia` llama
--     primero a Stripe (pause_collection) y luego a este RPC (rollback si falla).
--   · sync_membresia_stripe acepta 'pausada' (el webhook la deriva de
--     subscription.pause_collection) para que un subscription.updated no
--     des-pause la membresía por accidente.
-- Idempotente. (SALA pausar-membresia.)
-- ============================================================================

-- ── 1. Estado nuevo ──────────────────────────────────────────────────────────
ALTER TABLE membresias DROP CONSTRAINT IF EXISTS membresias_status_check;
ALTER TABLE membresias ADD CONSTRAINT membresias_status_check
  CHECK (status IN ('pendiente', 'trialing', 'activa', 'past_due', 'pausada', 'cancelada', 'expirada'));

ALTER TABLE membresias ADD COLUMN IF NOT EXISTS pausada_at timestamptz;

-- ── 2. RPC de staff ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION staff_pausar_membresia(p_usuario_id uuid, p_pausar boolean, p_motivo text DEFAULT NULL)
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
  v_nuevo text;
  v_now timestamptz := now();
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden pausar membresías';
  END IF;
  IF COALESCE(length(trim(p_motivo)), 0) < 3 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Indica el motivo';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  IF p_pausar THEN
    SELECT * INTO v_mem FROM membresias
    WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due')
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF v_mem.id IS NULL THEN
      RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que pausar';
    END IF;
    v_nuevo := 'pausada';
    UPDATE membresias SET status = 'pausada', pausada_at = v_now, updated_at = v_now WHERE id = v_mem.id;
    UPDATE usuarios SET status = 'suspendido' WHERE id = p_usuario_id;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (v_tenant, p_usuario_id, 'membresia_pausada', 'Tu membresía está en pausa',
            'Pausamos tu membresía: no se te cobrará ni podrás reservar hasta que se reactive. Pasa a recepción cuando quieras volver.',
            jsonb_build_object('membresia_id', v_mem.id));
  ELSE
    SELECT * INTO v_mem FROM membresias
    WHERE usuario_id = p_usuario_id AND status = 'pausada'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF v_mem.id IS NULL THEN
      RAISE EXCEPTION 'EKKO_SIN_PAUSA: El miembro no tiene una membresía pausada';
    END IF;
    v_nuevo := 'activa';
    UPDATE membresias SET status = 'activa', pausada_at = NULL, updated_at = v_now WHERE id = v_mem.id;
    UPDATE usuarios SET status = 'activo', membresia_activa_id = v_mem.id WHERE id = p_usuario_id;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (v_tenant, p_usuario_id, 'membresia_reactivada', 'Tu membresía volvió',
            'Reactivamos tu membresía: ya puedes volver a reservar.',
            jsonb_build_object('membresia_id', v_mem.id));
  END IF;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, CASE WHEN p_pausar THEN 'membresia_pausada' ELSE 'membresia_reactivada' END,
          'usuario', p_usuario_id,
          jsonb_build_object('membresia_status', v_mem.status, 'usuario_status', v_usuario.status),
          jsonb_build_object('membresia_status', v_nuevo, 'usuario_status', CASE WHEN p_pausar THEN 'suspendido' ELSE 'activo' END),
          trim(p_motivo), jsonb_build_object('membresia_id', v_mem.id, 'stripe_subscription_id', v_mem.stripe_subscription_id));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id, 'status', v_nuevo,
                            'stripe_subscription_id', v_mem.stripe_subscription_id);
END;
$$;

REVOKE ALL ON FUNCTION staff_pausar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_pausar_membresia(uuid, boolean, text) TO authenticated;

-- ── 3. sync_membresia_stripe entiende 'pausada' ──────────────────────────────
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
  --   cancelada       → corta acceso y suelta la membresía activa.
  IF v_new_status IN ('activa', 'past_due') THEN
    UPDATE usuarios SET status = 'activo'
    WHERE id = v_mem.usuario_id AND status <> 'activo';
  ELSIF v_new_status = 'pausada' THEN
    UPDATE usuarios SET status = 'suspendido'
    WHERE id = v_mem.usuario_id AND status = 'activo';
  ELSIF v_new_status = 'cancelada' THEN
    UPDATE usuarios SET status = 'cancelado', membresia_activa_id = NULL
    WHERE id = v_mem.usuario_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'estado', v_new_status, 'membresia_id', v_mem.id);
END;
$$;

REVOKE EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) TO service_role;

-- ── Self-test ────────────────────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'membresias_status_check' AND pg_get_constraintdef(oid) LIKE '%pausada%'
  ) THEN
    RAISE EXCEPTION 'membresias_status_check debe incluir pausada';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'sync_membresia_stripe';
  IF position('pausada' in v_src) = 0 OR position('evento_viejo' in v_src) = 0 THEN
    RAISE EXCEPTION 'sync_membresia_stripe perdió pausada o la guardia de orden';
  END IF;
  IF has_function_privilege('anon', 'staff_pausar_membresia(uuid, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'staff_pausar_membresia no debe ser ejecutable por anon';
  END IF;
END $$;
