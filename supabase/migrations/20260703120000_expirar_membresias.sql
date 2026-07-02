-- ============================================================================
-- Cron: expirar membresías vencidas por fecha
-- ----------------------------------------------------------------------------
-- Hasta ahora el vencimiento era LAZY (se chequeaba al reservar), así que los
-- dashboards seguían viendo "activas" membresías cuyo periodo ya terminó. Esta
-- RPC (la corre `cron-expirar-membresias` a diario) las marca `expirada`.
--
-- Alcance seguro: SOLO membresías con vencimiento por fecha que NO son
-- suscripciones de Stripe (stripe_subscription_id IS NULL) — las de Stripe las
-- maneja su propio ciclo vía webhook (activa/past_due/cancelada). Los planes por
-- créditos puros no vencen por fecha (periodo_actual_fin NULL) → no se tocan.
-- No modifica `usuarios.status`: el miembro sigue siendo miembro, sin paquete
-- vigente.
-- ============================================================================

CREATE OR REPLACE FUNCTION expirar_membresias_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH vencidas AS (
    UPDATE membresias
    SET status = 'expirada', updated_at = now()
    WHERE status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL
      AND periodo_actual_fin IS NOT NULL
      AND periodo_actual_fin < now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM vencidas;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION expirar_membresias_vencidas() IS
  'Marca expirada las membresías de paquete (no-Stripe) cuyo periodo ya pasó. La corre el cron a diario.';
