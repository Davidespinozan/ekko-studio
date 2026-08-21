-- ============================================================================
-- Créditos: la devolución usa la MISMA ventana que la cancelación
-- ============================================================================
-- `creditos_devolver_al_cancelar` decidía "a tiempo" con
-- config.reserva.anticipacion_min_horas (la anticipación para RESERVAR, 24h),
-- mientras que `cancelar_reserva_atomic` (20260704200000) deja al miembro
-- cancelar según config.reserva.cancelacion_min_horas_antes. Con cancelación=2h
-- y anticipación=24h, un miembro que cancelaba a 12h (permitido) PERDÍA el
-- crédito sin aviso. Ahora ambos leen `cancelacion_min_horas_antes`:
--   · 0 (o ausente) → sin ventana: toda cancelación del miembro devuelve.
--   · N > 0         → devuelve si slot_inicio > now() + N horas.
--   · cancelada_admin (el estudio cancela) → siempre devuelve.
-- Idempotente; el resto del trigger queda igual que en 20260702120000.
-- ============================================================================

CREATE OR REPLACE FUNCTION creditos_devolver_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem       membresias;
  v_min_horas numeric;
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

  -- Misma regla que cancelar_reserva_atomic: la ventana de CANCELACIÓN.
  SELECT COALESCE((config->'reserva'->>'cancelacion_min_horas_antes')::numeric, 0)
    INTO v_min_horas FROM tenants WHERE id = NEW.tenant_id;
  v_a_tiempo := (v_min_horas <= 0)
             OR (NEW.slot_inicio > now() + (v_min_horas || ' hours')::interval);

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

COMMENT ON FUNCTION creditos_devolver_al_cancelar() IS
  'Trigger sobre reservas: al cancelar, devuelve el crédito debitado si cancela el estudio o si el miembro cancela dentro de config.reserva.cancelacion_min_horas_antes (misma ventana que cancelar_reserva_atomic).';

-- ── Self-test de contrato ────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE proname = 'creditos_devolver_al_cancelar' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL OR position('cancelacion_min_horas_antes' in v_src) = 0 THEN
    RAISE EXCEPTION 'creditos_devolver_al_cancelar() debe usar config.reserva.cancelacion_min_horas_antes';
  END IF;
  IF position('anticipacion_min_horas' in v_src) > 0 THEN
    RAISE EXCEPTION 'creditos_devolver_al_cancelar() no debe decidir con anticipacion_min_horas (es la ventana para reservar, no para cancelar)';
  END IF;
END $$;
