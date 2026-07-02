-- ============================================================================
-- Costo en créditos POR ESTUDIO
-- ----------------------------------------------------------------------------
-- Antes toda reserva descontaba 1 crédito fijo. Ahora cada estudio puede costar
-- distinto (ej. Black = 2, Estudio 1 = 1). El costo vive en `recursos.costo_creditos`
-- (default 1 → comportamiento idéntico al actual hasta que el admin lo cambie).
--
-- Los triggers de débito/devolución se re-crean para usar el costo del estudio.
-- La DEVOLUCIÓN lee el monto realmente debitado del ledger → siempre devuelve
-- exactamente lo que cobró, aunque el costo del estudio cambie después.
-- ============================================================================

-- ── 1. Columna de costo por estudio ─────────────────────────────────────────
ALTER TABLE recursos
  ADD COLUMN IF NOT EXISTS costo_creditos integer NOT NULL DEFAULT 1
    CHECK (costo_creditos >= 1);

COMMENT ON COLUMN recursos.costo_creditos IS
  'Créditos/sesiones que descuenta una reserva de este estudio (planes por paquete). Default 1.';

-- ── 2. Débito al reservar: usa el costo del estudio ─────────────────────────
CREATE OR REPLACE FUNCTION creditos_debitar_al_reservar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem  membresias;
  v_tipo text;
  v_costo integer;
BEGIN
  IF NEW.status <> 'confirmada' THEN
    RETURN NEW;
  END IF;

  SELECT m.* INTO v_mem
  FROM membresias m
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_mem.id IS NULL THEN
    RETURN NEW;  -- sin membresía → el RPC ya gatea status='activo'
  END IF;

  SELECT tipo INTO v_tipo FROM tiers WHERE id = v_mem.tier_id;

  IF v_tipo IN ('creditos', 'hibrido') THEN
    IF v_mem.periodo_actual_fin IS NOT NULL AND v_mem.periodo_actual_fin <= now() THEN
      RAISE EXCEPTION 'EKKO_MEMBRESIA_VENCIDA: Tu paquete venció. Renová para seguir reservando.';
    END IF;

    -- Costo del estudio (default 1 si no está definido).
    SELECT COALESCE(costo_creditos, 1) INTO v_costo FROM recursos WHERE id = NEW.recurso_id;
    v_costo := COALESCE(v_costo, 1);

    IF COALESCE(v_mem.creditos_restantes, 0) < v_costo THEN
      RAISE EXCEPTION 'EKKO_SIN_CREDITOS: No te alcanzan los créditos para este estudio (cuesta %). Comprá un paquete para reservar.', v_costo;
    END IF;

    UPDATE membresias
    SET creditos_restantes = creditos_restantes - v_costo, updated_at = now()
    WHERE id = v_mem.id;

    INSERT INTO membresia_movimientos (
      tenant_id, membresia_id, usuario_id, reserva_id, tipo, delta, saldo_after, motivo
    ) VALUES (
      NEW.tenant_id, v_mem.id, NEW.usuario_id, NEW.id, 'debito', -v_costo,
      v_mem.creditos_restantes - v_costo,
      'Reserva ' || COALESCE(NEW.folio, '') || ' (' || v_costo || ' créd.)'
    );
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Devolución al cancelar: devuelve EXACTAMENTE lo debitado ──────────────
CREATE OR REPLACE FUNCTION creditos_devolver_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem       membresias;
  v_min_horas integer;
  v_a_tiempo  boolean;
  v_debito    integer;  -- delta del débito (negativo)
  v_devolver  integer;  -- monto a devolver (positivo)
BEGIN
  IF NOT (OLD.status = 'confirmada' AND NEW.status IN ('cancelada', 'cancelada_admin')) THEN
    RETURN NEW;
  END IF;

  -- Monto realmente debitado por esta reserva (si lo hubo y no se devolvió ya).
  SELECT delta INTO v_debito
  FROM membresia_movimientos
  WHERE reserva_id = NEW.id AND tipo = 'debito'
  LIMIT 1;

  IF v_debito IS NULL THEN
    RETURN NEW;  -- no hubo débito (plan por tiempo, o sin créditos)
  END IF;
  IF EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = NEW.id AND tipo = 'devolucion') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE((config->'reserva'->>'anticipacion_min_horas')::integer, 24)
    INTO v_min_horas FROM tenants WHERE id = NEW.tenant_id;
  v_a_tiempo := NEW.slot_inicio > now() + (v_min_horas || ' hours')::interval;

  -- El miembro que cancela tarde pierde el crédito; el estudio siempre devuelve.
  IF NEW.status <> 'cancelada_admin' AND NOT v_a_tiempo THEN
    RETURN NEW;
  END IF;

  v_devolver := -v_debito;  -- ej. débito -2 → devuelve 2

  SELECT m.* INTO v_mem
  FROM membresias m
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_mem.id IS NULL OR v_mem.creditos_restantes IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE membresias
  SET creditos_restantes = creditos_restantes + v_devolver, updated_at = now()
  WHERE id = v_mem.id;

  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, reserva_id, tipo, delta, saldo_after, motivo
  ) VALUES (
    NEW.tenant_id, v_mem.id, NEW.usuario_id, NEW.id, 'devolucion', v_devolver,
    v_mem.creditos_restantes + v_devolver,
    CASE WHEN NEW.status = 'cancelada_admin'
         THEN 'Devolución (cancelado por el estudio)'
         ELSE 'Devolución (cancelación a tiempo)' END
  );

  RETURN NEW;
END;
$$;
