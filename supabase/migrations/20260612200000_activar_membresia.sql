-- ============================================================================
-- Pagos — RPC keystone de activación de membresía (plug-and-play Stripe)
-- ============================================================================
-- D4 (David): suscripción mensual por tier · sin trial · self-serve + recepción.
--
-- `activar_membresia` es el ÚNICO punto de activación. Lo llaman:
--   - reception-activar-membresia  (cobro en mostrador, funciona HOY)
--   - stripe-webhook               (cuando se conecte Stripe)
--   - suscribir-membresia          (demo/simulado, si se habilita)
-- Una sola fuente de verdad → cierra B3 (cambiar tier ahora SÍ activa la cuenta
-- de forma consistente, creando la fila en `membresias` y poniendo status='activo').
--
-- La tabla `membresias` (con su unique "una activa por usuario") deja de estar
-- muerta: pasa a ser el state machine real de la suscripción.
-- ============================================================================

CREATE OR REPLACE FUNCTION activar_membresia(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usuario usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_membresia_id uuid;
BEGIN
  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado';
  END IF;

  SELECT * INTO v_tier
  FROM tiers
  WHERE id = p_tier_id AND tenant_id = v_usuario.tenant_id AND activo = true;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo';
  END IF;

  -- Periodo: el que pase Stripe, o 1 mes por defecto (suscripción mensual).
  v_fin := COALESCE(p_periodo_fin, v_now + interval '1 month');

  -- Cerrar cualquier membresía activa previa (respeta el unique index
  -- "una activa por usuario"). Cambio de plan = cancela la vieja, crea la nueva.
  UPDATE membresias
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_efectiva_at = v_now,
      updated_at = v_now
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due');

  -- Crear la membresía activa.
  INSERT INTO membresias (
    tenant_id, usuario_id, tier_id, status,
    periodo_actual_inicio, periodo_actual_fin,
    stripe_subscription_id, stripe_customer_id
  ) VALUES (
    v_usuario.tenant_id, p_usuario_id, p_tier_id, 'activa',
    v_now, v_fin,
    p_stripe_subscription_id, p_stripe_customer_id
  )
  RETURNING id INTO v_membresia_id;

  -- Reflejar en `usuarios` (la app gatea por status + membresia_tier).
  -- SECURITY DEFINER → el trigger C2 no aplica (current_user = owner, no
  -- 'authenticated'), así que puede tocar status/tier.
  UPDATE usuarios
  SET status = 'activo',
      membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'tier', v_tier.slug,
    'periodo_fin', v_fin
  );
END;
$$;

-- Solo el backend (service_role) activa — nunca el cliente directo.
REVOKE EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz)
  TO service_role;
