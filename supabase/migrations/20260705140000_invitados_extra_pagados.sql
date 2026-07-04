-- ============================================================================
-- Invitados extra PAGADOS en la app (Stripe) — nada de efectivo/terminal
-- ----------------------------------------------------------------------------
-- El miembro paga sus invitados extra desde la app (al reservar o después). Se
-- lleva un contador por reserva de cuántos extras quedaron PAGADOS. Recepción
-- solo registra nombres/fotos y ve la cobertura: los extras cubiertos = tope del
-- plan + invitados_extra_pagados. Lo no pagado lo cubre el miembro en su app
-- (no se cobra en mostrador).
--
-- El webhook de Stripe (payment_intent.succeeded, tipo='invitados_extra') llama a
-- registrar_invitados_extra_pagados para sumar los extras pagados a la reserva.
-- ============================================================================

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS invitados_extra_pagados integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN reservas.invitados_extra_pagados IS
  'Invitados extra que el miembro pagó en la app (Stripe). Cobertura de extras = tope del plan + este contador.';

-- Suma extras pagados a una reserva. La idempotencia la garantiza el webhook
-- (stripe_webhook_events dedup por event id): cada payment_intent.succeeded se
-- procesa una sola vez.
CREATE OR REPLACE FUNCTION registrar_invitados_extra_pagados(
  p_reserva_id uuid,
  p_cantidad integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reserva reservas;
BEGIN
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cantidad_invalida');
  END IF;

  UPDATE reservas
  SET invitados_extra_pagados = invitados_extra_pagados + p_cantidad
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  IF v_reserva.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'reserva_no_encontrada');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva.id,
    'invitados_extra_pagados', v_reserva.invitados_extra_pagados
  );
END;
$$;

REVOKE ALL ON FUNCTION registrar_invitados_extra_pagados(uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_invitados_extra_pagados(uuid, integer) TO service_role;
