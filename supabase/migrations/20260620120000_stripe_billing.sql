-- ============================================================================
-- Pagos — billing robusto de Stripe (webhook idempotente + sincronización)
-- ============================================================================
-- Complementa el RPC keystone `activar_membresia` (20260612200000) con lo que
-- hace falta para un webhook de Stripe correcto en producción. Patrones
-- aprendidos de HSC (proyecto hermano ya en producción):
--
--   1. Idempotencia: tabla `stripe_webhook_events` (PK = event.id). Stripe
--      reintenta y puede entregar el MISMO evento dos veces → sin dedupe,
--      activaríamos/cobraríamos doble.
--
--   2. Orden de eventos: Stripe NO garantiza orden de entrega. Un
--      `subscription.updated` viejo podía pisar un estado más fresco y degradar
--      a un miembro que SÍ está pagando. `membresias.last_sub_event_at` guarda
--      el timestamp del último evento aplicado; el sync ignora los más viejos.
--
--   3. Cancelar a fin de período: `cancel_at_period_end` (no cortamos acceso al
--      instante; el miembro sigue hasta que termina lo pagado).
--
-- `activar_membresia` sigue siendo el ÚNICO punto de ACTIVACIÓN (alta/cambio).
-- `sync_membresia_stripe` materializa los CAMBIOS DE ESTADO posteriores
-- (renovó, falló el pago, canceló). Ambos SECURITY DEFINER, solo service_role.
-- ============================================================================

-- ── Idempotencia de webhooks ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id          text PRIMARY KEY,                  -- event.id de Stripe
  type        text,
  received_at timestamptz NOT NULL DEFAULT now()
);
-- RLS on, SIN policies: solo service_role (que bypassa RLS) lo toca. Nunca el
-- cliente.
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- ── Columnas de billing que faltaban en membresias ──────────────────────────
ALTER TABLE membresias
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_sub_event_at    timestamptz;

COMMENT ON COLUMN membresias.cancel_at_period_end IS
  'Stripe: la suscripción se cancela al terminar el período pagado (no al instante).';
COMMENT ON COLUMN membresias.last_sub_event_at IS
  'Timestamp del último evento de Stripe aplicado. Guardia de orden: el webhook ignora eventos más viejos que este.';

-- ── RPC: sincronizar estado desde un evento de Stripe ───────────────────────
-- p_estado normalizado por el webhook a uno de: 'activa' | 'past_due' | 'cancelada'.
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
    -- La suscripción todavía no se materializó (p.ej. llegó subscription.updated
    -- antes que checkout.session.completed). El webhook lo loguea; no es fatal.
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

  -- Acceso del miembro (la app gatea por usuarios.status):
  --   activa/past_due → mantiene acceso. past_due es GRACIA mientras Stripe
  --                     reintenta el cobro (dunning); no cortamos al toque.
  --   cancelada       → corta acceso y suelta la membresía activa.
  IF v_new_status IN ('activa', 'past_due') THEN
    UPDATE usuarios SET status = 'activo'
    WHERE id = v_mem.usuario_id AND status <> 'activo';
  ELSIF v_new_status = 'cancelada' THEN
    UPDATE usuarios SET status = 'cancelado', membresia_activa_id = NULL
    WHERE id = v_mem.usuario_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'estado', v_new_status, 'membresia_id', v_mem.id);
END;
$$;

-- Solo el backend (service_role) sincroniza — nunca el cliente directo.
REVOKE EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz)
  TO service_role;
