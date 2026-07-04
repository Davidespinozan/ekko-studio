-- ============================================================================
-- El miembro no puede auto-cancelar demasiado tarde (recepción/admin sí)
-- ----------------------------------------------------------------------------
-- El botón del front ya oculta la cancelación tardía, pero el RPC no validaba la
-- ventana → un miembro podía cancelar tarde llamando el RPC directo. Ahora el RPC
-- respeta config.reserva.cancelacion_min_horas_antes SOLO cuando cancela el
-- propio miembro; recepción/admin (v_por_tercero) siguen cancelando cuando sea.
--
-- EKKO arranca con ventana de 24 h. Editable en Admin → Reglas. 0 = sin tope.
-- CREATE OR REPLACE del cuerpo vigente (20260521100000) + el bloque nuevo.
-- Idempotente.
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_reserva_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS reservas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_reserva reservas;
  v_por_tercero boolean;
  v_mensaje text;
  v_cancel_min_h numeric;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE';
  END IF;

  IF v_reserva.usuario_id != v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.usuario_id != v_user_id
     AND v_reserva.tenant_id IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: La reserva pertenece a otro estudio';
  END IF;

  IF v_reserva.status != 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_CANCELABLE: La reserva no está confirmada';
  END IF;

  IF v_reserva.slot_inicio < now() THEN
    RAISE EXCEPTION 'EKKO_RESERVA_PASADA: No puedes cancelar una reserva que ya pasó';
  END IF;

  v_por_tercero := (v_reserva.usuario_id != v_user_id);

  -- Ventana de cancelación: SOLO aplica al miembro que cancela lo suyo.
  -- Recepción/admin (v_por_tercero) cancelan cuando sea.
  IF NOT v_por_tercero THEN
    SELECT COALESCE((config->'reserva'->>'cancelacion_min_horas_antes')::numeric, 0)
      INTO v_cancel_min_h
      FROM tenants WHERE id = v_reserva.tenant_id;

    IF v_cancel_min_h > 0
       AND v_reserva.slot_inicio < now() + (v_cancel_min_h || ' hours')::interval THEN
      RAISE EXCEPTION 'EKKO_CANCELACION_TARDIA: Ya no puedes cancelar esta reserva por tu cuenta (faltan menos de % horas). Contacta a recepción.', v_cancel_min_h;
    END IF;
  END IF;

  IF v_por_tercero THEN
    UPDATE reservas
    SET status = 'cancelada_admin',
        cancelada_at = now(),
        cancelada_motivo = p_motivo,
        cancelada_por = v_user_id,
        cancelacion_notificada_at = now()
    WHERE id = p_reserva_id
    RETURNING * INTO v_reserva;

    v_mensaje := 'Tu reserva del '
      || to_char(v_reserva.slot_inicio, 'DD/MM/YYYY HH24:MI')
      || ' fue cancelada por el estudio.'
      || CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
              THEN ' Motivo: ' || p_motivo ELSE '' END;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_reserva.tenant_id,
      v_reserva.usuario_id,
      'reserva_cancelada',
      'Tu reserva fue cancelada',
      v_mensaje,
      jsonb_build_object('reserva_id', p_reserva_id)
    );
  ELSE
    UPDATE reservas
    SET status = 'cancelada',
        cancelada_at = now(),
        cancelada_motivo = p_motivo
    WHERE id = p_reserva_id
    RETURNING * INTO v_reserva;
  END IF;

  RETURN v_reserva;
END;
$$;

-- EKKO arranca con ventana de 24 h (editable en admin).
UPDATE tenants
SET config = jsonb_set(config, '{reserva,cancelacion_min_horas_antes}', '24'::jsonb, true)
WHERE slug = 'ekko'
  AND NOT (COALESCE(config->'reserva', '{}'::jsonb) ? 'cancelacion_min_horas_antes');
