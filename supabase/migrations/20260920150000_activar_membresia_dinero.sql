-- ============================================================================
-- activar_membresia: idempotente por pago, no acorta vigencias, entiende la pausa
-- ============================================================================
-- Cuerpo copiado de la definición vigente (20260704170000:24-172). Cambios:
--
-- M2 · Doble acreditación de paquetes. La función solo era idempotente cuando
--   venía `p_stripe_subscription_id`; un paquete (pago único) llega con NULL. En
--   Checkout, la sesión y su PaymentIntent llevan el mismo metadata y los DOS
--   eventos activan → pagaba 6 créditos y recibía 12. Ahora el pago único trae
--   `p_referencia` (id del PaymentIntent, igual en ambos eventos): se guarda en
--   `membresias.referencia_pago` (único) y un segundo evento es no-op.
--   El usuario se bloquea `FOR UPDATE`, así que dos eventos simultáneos se
--   serializan y el segundo ve la fila del primero (antes chocaban con
--   membresias_one_active_per_user → 500 → reintento → doble crédito igual).
--
-- M3 · Recomprar acortaba la vigencia. Los créditos del paquete anterior se
--   suman al nuevo, pero la fecha se recalculaba como hoy + duración del NUEVO:
--   10 créditos con 100 días + una "sesión suelta" (30 días) = 11 créditos que
--   vencen en 30 días. Ahora el paquete nuevo vence en la fecha MÁS LEJANA entre
--   la suya y la del saldo que arrastra. Y una mensualidad de mostrador (sin
--   Stripe) renovada antes de vencer apila desde su fin actual: renovar el día
--   27 ya no regala 3 días al estudio. (SALA f79162a / 20260819210000.)
--
-- M4 · La pausa quedaba fuera del modelo "una membresía viva". Activar un plan a
--   un miembro en pausa dejaba una `pausada` + una `activa` (y "Reanudar" tronaba
--   con 23505). Ahora `pausada` se cierra y arrastra su saldo como cualquier otra.
--
-- M12 · Cambiar a un plan SIN créditos quema el saldo del paquete anterior. La
--   UI ya avisaba; el servidor no. Con `p_confirmar_perdida = false` la función
--   rechaza con EKKO_PERDERIA_CREDITOS. Default true: el webhook (ya cobrado)
--   nunca se bloquea; recepción manda false salvo confirmación explícita.
--
-- Tests conductuales: src/__tests__/db/membresias-dinero.db.test.ts
-- ============================================================================

ALTER TABLE membresias ADD COLUMN IF NOT EXISTS referencia_pago text;
COMMENT ON COLUMN membresias.referencia_pago IS
  'Id del pago único que originó la membresía (PaymentIntent de Stripe). Llave de idempotencia de activar_membresia para paquetes.';
CREATE UNIQUE INDEX IF NOT EXISTS membresias_referencia_pago_uniq
  ON membresias (referencia_pago) WHERE referencia_pago IS NOT NULL;

-- Una sola membresía "viva" por miembro, contando la pausa.
DROP INDEX IF EXISTS membresias_one_active_per_user;
CREATE UNIQUE INDEX membresias_one_active_per_user
  ON membresias (usuario_id)
  WHERE status IN ('trialing', 'activa', 'past_due', 'pausada');

-- La firma cambia (2 parámetros nuevos con default): fuera la vieja para que no
-- queden dos sobrecargas ambiguas al llamar con argumentos nombrados.
DROP FUNCTION IF EXISTS activar_membresia(uuid, uuid, text, text, timestamptz);

CREATE OR REPLACE FUNCTION activar_membresia(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL,
  p_referencia text DEFAULT NULL,
  p_confirmar_perdida boolean DEFAULT true
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
  v_es_paquete boolean;
  v_saldo_previo integer := 0;
  v_fin_previo timestamptz;
  v_creditos integer;
  v_existente uuid;
  v_previa membresias;
  v_previa_tipo text;
BEGIN
  -- FOR UPDATE: serializa dos activaciones simultáneas del mismo miembro.
  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado';
  END IF;

  SELECT * INTO v_tier
  FROM tiers
  WHERE id = p_tier_id AND tenant_id = v_usuario.tenant_id AND activo = true;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo';
  END IF;

  -- #5 Idempotencia por suscripción: si ya hay una membresía viva con esta sub,
  -- el evento es duplicado (reintento de Stripe / dos eventos del mismo pago) → no-op.
  IF p_stripe_subscription_id IS NOT NULL THEN
    SELECT id INTO v_existente
    FROM membresias
    WHERE usuario_id = p_usuario_id
      AND stripe_subscription_id = p_stripe_subscription_id
      AND status IN ('trialing', 'activa', 'past_due', 'pausada')
    LIMIT 1;
    IF v_existente IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'membresia_id', v_existente, 'idempotente', true);
    END IF;
  END IF;

  -- M2 Idempotencia por pago único: este pago ya activó una membresía (viva o
  -- no: si ya se consumió o se reemplazó, el pago NO se vuelve a acreditar).
  IF p_referencia IS NOT NULL THEN
    SELECT id INTO v_existente FROM membresias WHERE referencia_pago = p_referencia LIMIT 1;
    IF v_existente IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'membresia_id', v_existente, 'idempotente', true);
    END IF;
  END IF;

  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido');

  -- #9 Saldo previo para ACUMULAR: NO revivir créditos de paquetes ya vencidos
  -- por fecha (aunque el cron aún no los haya barrido). M3: se guarda también
  -- hasta cuándo valía ese saldo (NULL = no caducaba).
  SELECT COALESCE(SUM(creditos_restantes), 0),
         MAX(COALESCE(periodo_actual_fin, 'infinity'::timestamptz))
    INTO v_saldo_previo, v_fin_previo
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due', 'pausada')
    AND COALESCE(creditos_restantes, 0) > 0
    AND (periodo_actual_fin IS NULL OR periodo_actual_fin > v_now);

  -- M12 El plan nuevo no lleva créditos: el saldo se perdería.
  IF NOT v_es_paquete AND v_saldo_previo > 0 AND NOT COALESCE(p_confirmar_perdida, true) THEN
    RAISE EXCEPTION 'EKKO_PERDERIA_CREDITOS: El miembro perdería % crédito(s) al cambiar a este plan', v_saldo_previo;
  END IF;
  IF NOT v_es_paquete THEN
    v_saldo_previo := 0;
  END IF;

  -- Membresía viva actual (para apilar una renovación de mostrador).
  SELECT m.* INTO v_previa
  FROM membresias m
  WHERE m.usuario_id = p_usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
  ORDER BY m.created_at DESC
  LIMIT 1;
  IF v_previa.id IS NOT NULL THEN
    SELECT tipo INTO v_previa_tipo FROM tiers WHERE id = v_previa.tier_id;
  END IF;

  -- Vigencia según tipo.
  IF v_tier.tipo = 'creditos' THEN
    v_fin := NULL;
  ELSIF v_tier.tipo = 'hibrido' THEN
    v_fin := v_now + (COALESCE(v_tier.duracion_dias, 30) || ' days')::interval;
    -- M3: el saldo arrastrado no pierde vigencia por comprar un paquete más corto.
    IF v_saldo_previo > 0 AND v_fin_previo IS NOT NULL THEN
      v_fin := CASE WHEN v_fin_previo = 'infinity'::timestamptz THEN NULL
                    ELSE GREATEST(v_fin, v_fin_previo) END;
    END IF;
  ELSE  -- tiempo
    v_fin := COALESCE(
      p_periodo_fin,
      -- M3: renovación de mostrador del MISMO plan antes de vencer → apila desde
      -- su fin actual. Con Stripe (p_periodo_fin) manda Stripe.
      (CASE WHEN v_previa.id IS NOT NULL
                 AND v_previa.tier_id = p_tier_id
                 AND v_previa_tipo = 'tiempo'
                 AND v_previa.stripe_subscription_id IS NULL
                 AND v_previa.periodo_actual_fin > v_now
            THEN v_previa.periodo_actual_fin ELSE v_now END)
      + CASE WHEN v_tier.duracion_dias IS NOT NULL
             THEN (v_tier.duracion_dias || ' days')::interval
             ELSE interval '1 month' END
    );
  END IF;

  IF v_es_paquete THEN
    v_creditos := v_saldo_previo + COALESCE(v_tier.clases_incluidas, 0);
  ELSE
    v_creditos := NULL;
  END IF;

  -- #10 Asentar en el ledger los créditos que salen de la membresía previa
  -- (antes quedaban "vivos" fantasma), y luego zerarlos.
  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
  )
  SELECT tenant_id, id, usuario_id, 'ajuste', -creditos_restantes, 0, 'Cierre de membresía anterior'
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due', 'pausada')
    AND COALESCE(creditos_restantes, 0) > 0;

  UPDATE membresias
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_efectiva_at = v_now,
      creditos_restantes = CASE WHEN creditos_restantes IS NULL THEN NULL ELSE 0 END,
      updated_at = v_now
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due', 'pausada');

  -- Crear la membresía activa.
  INSERT INTO membresias (
    tenant_id, usuario_id, tier_id, status,
    periodo_actual_inicio, periodo_actual_fin, creditos_restantes,
    stripe_subscription_id, stripe_customer_id, referencia_pago
  ) VALUES (
    v_usuario.tenant_id, p_usuario_id, p_tier_id, 'activa',
    v_now, v_fin, v_creditos,
    p_stripe_subscription_id, p_stripe_customer_id, p_referencia
  )
  RETURNING id INTO v_membresia_id;

  -- Ledger: alta FRESCA (delta = clases del plan; el arrastre va como asiento aparte).
  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
  ) VALUES (
    v_usuario.tenant_id, v_membresia_id, p_usuario_id, 'alta',
    COALESCE(v_tier.clases_incluidas, 0),
    CASE WHEN v_es_paquete THEN COALESCE(v_tier.clases_incluidas, 0) ELSE NULL END,
    'Alta de ' || v_tier.slug
  );

  -- #10 Créditos arrastrados del plan anterior, como movimiento propio para que
  -- el ledger de la nueva membresía reconcilie con su saldo.
  IF v_es_paquete AND v_saldo_previo > 0 THEN
    INSERT INTO membresia_movimientos (
      tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
    ) VALUES (
      v_usuario.tenant_id, v_membresia_id, p_usuario_id, 'ajuste',
      v_saldo_previo, v_creditos, 'Créditos trasladados del plan anterior'
    );
  END IF;

  UPDATE usuarios
  SET status = 'activo',
      membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'tier', v_tier.slug,
    'periodo_fin', v_fin,
    'creditos', v_creditos
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz, text, boolean)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz, text, boolean)
  TO service_role;
