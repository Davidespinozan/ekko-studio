-- ============================================================================
-- Reservar exige una membresía VIVA — y el débito de créditos por fin funciona
-- ============================================================================
-- Dos bugs en el mismo trigger (`creditos_debitar_al_reservar`):
--
-- A) NINGÚN miembro con paquete podía reservar. El trigger era BEFORE INSERT e
--    insertaba en `membresia_movimientos` una fila con `reserva_id = NEW.id`
--    cuando la reserva todavía no existía; la FK no es diferible →
--    "violates foreign key constraint membresia_movimientos_reserva_id_fkey".
--    Los mensuales no lo veían porque no generan asiento. Se detectó al ejecutar
--    la RPC contra un Postgres real (src/__tests__/db).
--    Fix: el trigger pasa a AFTER INSERT (la fila ya existe; un RAISE aquí
--    aborta igual toda la inserción). De paso, un slot ocupado ya no llega a
--    debitar: el EXCLUDE de `reservas` truena antes.
--
-- B) Reserva gratis sin membresía (SALA_PARITY_AUDIT_2 · P0-5). Sin membresía
--    viva el trigger hacía `RETURN NEW` "porque el RPC ya gatea status=activo",
--    pero el cron de expiración deja `status='activo'` y, desde 20260821130000,
--    `tiers_permitidos` vacío = estudio abierto aunque el tier sea NULL. Un
--    miembro con el paquete vencido reservaba gratis cualquier estudio abierto.
--    Fix: sin membresía viva → EKKO_SIN_MEMBRESIA. Vale para las dos RPC
--    (miembro y recepción): todas las inserciones a `reservas` pasan por aquí.
--
-- Vigencia por fecha:
--   · creditos/hibrido → como antes (EKKO_MEMBRESIA_VENCIDA).
--   · tiempo SIN suscripción Stripe (cortesía/transferencia en mostrador) →
--     también se valida la fecha. Con suscripción Stripe manda el status que
--     sincroniza el webhook (past_due = gracia), no la fecha: `invoice.paid`
--     puede llegar horas después del fin de periodo.
-- ============================================================================

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
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: No hay un plan vigente. Se necesita un plan o paquete para reservar.';
  END IF;

  SELECT tipo INTO v_tipo FROM tiers WHERE id = v_mem.tier_id;

  IF v_tipo IN ('creditos', 'hibrido') THEN
    IF v_mem.periodo_actual_fin IS NOT NULL AND v_mem.periodo_actual_fin <= now() THEN
      RAISE EXCEPTION 'EKKO_MEMBRESIA_VENCIDA: El paquete venció. Hay que renovar para seguir reservando.';
    END IF;

    -- Costo del estudio (default 1 si no está definido).
    SELECT COALESCE(costo_creditos, 1) INTO v_costo FROM recursos WHERE id = NEW.recurso_id;
    v_costo := COALESCE(v_costo, 1);

    IF COALESCE(v_mem.creditos_restantes, 0) < v_costo THEN
      RAISE EXCEPTION 'EKKO_SIN_CREDITOS: No alcanzan los créditos para este estudio (cuesta %). Hay que comprar un paquete para reservar.', v_costo;
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
  ELSIF v_mem.stripe_subscription_id IS NULL
        AND v_mem.periodo_actual_fin IS NOT NULL
        AND v_mem.periodo_actual_fin <= now() THEN
    RAISE EXCEPTION 'EKKO_MEMBRESIA_VENCIDA: La membresía venció. Hay que renovar para seguir reservando.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION creditos_debitar_al_reservar() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_creditos_debitar ON reservas;
CREATE TRIGGER trg_creditos_debitar
  AFTER INSERT ON reservas
  FOR EACH ROW
  EXECUTE FUNCTION creditos_debitar_al_reservar();
