-- ============================================================================
-- Avisos de reserva: confirmación + correo (solicitud del cliente, punto 4)
-- ============================================================================
-- El cliente pide que al reservar llegue una confirmación por correo, y que los
-- cambios relevantes (cancelación, cambio de horario, pago…) lleguen por correo
-- Y por la app.
--
--  1. `notificaciones.email_enviado_at`: mismo patrón que `push_enviado_at`
--     (EKKO-033). Un despachador central (`cron-email`) manda por correo lo
--     pendiente, venga de donde venga, en vez de cablear un envío por disparador.
--     Lo que ya existía se marca como enviado: encender Resend no debe disparar
--     una ráfaga de avisos viejos.
--  2. Confirmación de reserva: NO existía ni en la app. Trigger AFTER INSERT sobre
--     `reservas` (cubre la app y recepción): deja el aviso `reserva_confirmada`
--     con set, fecha y hora DEL ESTUDIO, folio y el enlace al QR.
--  3. El miembro que cancela SU reserva también recibe constancia
--     (`reserva_cancelada_por_ti`): antes solo se avisaba si cancelaba el estudio.
--  4. `cancelar_reserva_atomic`: la hora del aviso salía en UTC. Cuerpo copiado
--     programáticamente de 20260704200000; cambia solo esa línea (+ la url).
--
-- Tests conductuales: src/__tests__/db/avisos-reserva.db.test.ts
-- ============================================================================

ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS email_enviado_at timestamptz;
UPDATE notificaciones SET email_enviado_at = creada_at WHERE email_enviado_at IS NULL;
CREATE INDEX IF NOT EXISTS notificaciones_email_pendiente_idx
  ON notificaciones (creada_at) WHERE email_enviado_at IS NULL;

-- "lunes 21 de septiembre, 17:00" en la zona del estudio.
CREATE OR REPLACE FUNCTION _fecha_hora_estudio(p_instante timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])
           [extract(dow FROM (p_instante AT TIME ZONE 'America/Mazatlan'))::int + 1]
      || ' ' || extract(day FROM (p_instante AT TIME ZONE 'America/Mazatlan'))::int
      || ' de '
      || (ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])
           [extract(month FROM (p_instante AT TIME ZONE 'America/Mazatlan'))::int]
      || ', ' || to_char(p_instante AT TIME ZONE 'America/Mazatlan', 'HH24:MI');
$$;
REVOKE ALL ON FUNCTION _fecha_hora_estudio(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION _fecha_hora_estudio(timestamptz) TO authenticated, service_role;

-- ── Confirmación al reservar / constancia al cancelar lo propio ──────────────
CREATE OR REPLACE FUNCTION reservas_avisar_al_miembro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_set text;
  v_por_staff boolean;
BEGIN
  SELECT nombre INTO v_set FROM recursos WHERE id = NEW.recurso_id;
  v_set := COALESCE(v_set, 'el estudio');

  IF TG_OP = 'INSERT' AND NEW.status = 'confirmada' THEN
    v_por_staff := get_my_user_id() IS DISTINCT FROM NEW.usuario_id;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      NEW.tenant_id, NEW.usuario_id, 'reserva_confirmada',
      'Reserva confirmada',
      CASE WHEN v_por_staff THEN 'Te agendamos ' ELSE 'Tienes ' END
        || v_set || ' el ' || _fecha_hora_estudio(NEW.slot_inicio)
        || ' (' || NEW.duracion_min || ' min).'
        || CASE WHEN NEW.folio IS NOT NULL THEN ' Folio ' || NEW.folio || '.' ELSE '' END
        || ' Muestra tu QR al llegar.',
      jsonb_build_object('reserva_id', NEW.id, 'url', '/app/qr/' || NEW.id,
                         'slot_inicio', NEW.slot_inicio, 'slot_fin', NEW.slot_fin, 'set', v_set)
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'confirmada' AND NEW.status = 'cancelada' THEN
    -- 'cancelada' = la canceló el propio miembro ('cancelada_admin' ya avisa la RPC).
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      NEW.tenant_id, NEW.usuario_id, 'reserva_cancelada_por_ti',
      'Cancelaste tu reserva',
      'Cancelaste ' || v_set || ' del ' || _fecha_hora_estudio(NEW.slot_inicio) || '. El horario quedó libre.',
      jsonb_build_object('reserva_id', NEW.id, 'url', '/app/reservas')
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reservas_avisar_al_miembro() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_avisar_al_miembro ON reservas;
CREATE TRIGGER trg_avisar_al_miembro
  AFTER INSERT OR UPDATE OF status ON reservas
  FOR EACH ROW EXECUTE FUNCTION reservas_avisar_al_miembro();

-- ── cancelar_reserva_atomic: la hora del aviso, en la zona del estudio ───────
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

    -- Hora de pared del ESTUDIO. Antes era to_char(slot_inicio, …) a secas: salía
    -- en UTC ("del 21/09 23:00" para una sesión de las 16:00) — y este texto ahora
    -- también se manda por correo.
    v_mensaje := 'Tu reserva del '
      || _fecha_hora_estudio(v_reserva.slot_inicio)
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
      jsonb_build_object('reserva_id', p_reserva_id, 'url', '/app/reservas')
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
