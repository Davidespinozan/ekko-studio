-- ============================================================================
-- Reprogramar = UN aviso de "cambio de horario", no dos mensajes contradictorios
-- ============================================================================
-- Solicitud del cliente, punto 4 ("Cambio de horario", "Modificación de la
-- reserva"). Recepción reprograma creando la reserva nueva y cancelando la vieja,
-- así que al miembro le llegaban DOS avisos (y dos correos): "Te agendamos…" y
-- "Tu reserva fue cancelada por el estudio. Motivo: Reprogramada por recepción".
-- Leídos por separado parecen una cancelación.
--
-- `staff_avisar_reprogramacion(reserva_vieja)` se llama al terminar la
-- reprogramación: retira ese par (recién creado) y deja uno solo que dice de dónde
-- a dónde se movió. Best-effort: si no encuentra el par (p. ej. ya se leyó), no
-- toca nada y los dos avisos originales siguen ahí.
-- ============================================================================

CREATE OR REPLACE FUNCTION staff_avisar_reprogramacion(p_reserva_vieja uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_vieja reservas;
  v_nueva reservas;
  v_aviso_nueva notificaciones;
  v_set_viejo text;
  v_set_nuevo text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede reprogramar';
  END IF;

  SELECT * INTO v_vieja FROM reservas
  WHERE id = p_reserva_vieja AND tenant_id = v_tenant AND status = 'cancelada_admin';
  IF v_vieja.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'reserva_vieja_no_cancelada');
  END IF;

  -- La confirmación de la reserva NUEVA: la más reciente del miembro, de hace instantes.
  SELECT * INTO v_aviso_nueva FROM notificaciones
  WHERE usuario_id = v_vieja.usuario_id AND tipo = 'reserva_confirmada'
    AND creada_at > now() - interval '5 minutes'
    AND (metadata->>'reserva_id') IS DISTINCT FROM p_reserva_vieja::text
  ORDER BY creada_at DESC LIMIT 1;
  IF v_aviso_nueva.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'sin_confirmacion_reciente');
  END IF;

  SELECT * INTO v_nueva FROM reservas
  WHERE id = (v_aviso_nueva.metadata->>'reserva_id')::uuid AND usuario_id = v_vieja.usuario_id AND status = 'confirmada';
  IF v_nueva.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'reserva_nueva_no_encontrada');
  END IF;

  SELECT nombre INTO v_set_viejo FROM recursos WHERE id = v_vieja.recurso_id;
  SELECT nombre INTO v_set_nuevo FROM recursos WHERE id = v_nueva.recurso_id;

  DELETE FROM notificaciones
  WHERE id = v_aviso_nueva.id
     OR (usuario_id = v_vieja.usuario_id AND tipo = 'reserva_cancelada'
         AND metadata->>'reserva_id' = p_reserva_vieja::text
         AND creada_at > now() - interval '5 minutes');

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (
    v_tenant, v_vieja.usuario_id, 'reserva_reprogramada',
    'Tu sesión cambió de horario',
    'Era ' || COALESCE(v_set_viejo, 'el estudio') || ' el ' || _fecha_hora_estudio(v_vieja.slot_inicio)
      || '. Ahora es ' || COALESCE(v_set_nuevo, 'el estudio') || ' el ' || _fecha_hora_estudio(v_nueva.slot_inicio)
      || ' (' || v_nueva.duracion_min || ' min).'
      || CASE WHEN v_nueva.folio IS NOT NULL THEN ' Folio ' || v_nueva.folio || '.' ELSE '' END
      || ' Si agregaste la anterior a tu calendario, actualízala.',
    jsonb_build_object('reserva_id', v_nueva.id, 'reserva_anterior_id', v_vieja.id, 'url', '/app/qr/' || v_nueva.id)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', v_nueva.id);
END;
$$;

REVOKE ALL ON FUNCTION staff_avisar_reprogramacion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_avisar_reprogramacion(uuid) TO authenticated;
