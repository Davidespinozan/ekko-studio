-- ============================================================================
-- R2-B · PKG-01O + 01P + 01Q · TERMINACIÓN, COBRO Y CANCELACIÓN
-- ----------------------------------------------------------------------------
-- Decisiones del dueño (2026-10-03):
--   D-01O-1 = B  Crédito que no se puede restaurar (derecho ya terminado): NO se
--                pierde en silencio ni se fabrica una membresía: evidencia +
--                UNA revisión humana + aviso al admin.
--   D-01O-2 = A  No se acepta una reserva cuya sesión ocurre después del fin
--                efectivo CONOCIDO del derecho (servidor). Y no se penaliza una
--                falta que EKKO mismo hizo imposible.
--   D-01P-1 = B  Sanción (temporal) → se SUSPENDE el cobro de Stripe y se reanuda
--                al levantarla si todo sigue válido. Revocación (terminal) → se
--                CANCELA la suscripción de inmediato, sin reembolso automático.
--                Si Stripe falla, la sanción/revocación sigue vigente y queda
--                evidencia durable reintentable.
--   D-01Q-1 = A  La cancelación distingue QUIÉN la causó (miembro / estudio).
--                Miembro tarde → se cancela y el crédito NO vuelve. Estudio →
--                el crédito vuelve si hay destino; si no, D-01O-1.
--   D-01Q-2 = A  Reserva cancelada con invitados extra pagados → UNA revisión
--                financiera. Sin reembolso automático; la evidencia no se toca.
--
-- Preserva: R1 (revocación persistente, sin resurrección), 01G (reembolso no
-- muta derechos), 01H / R2-A (evidencia y traslados de extras inmutables;
-- reprogramación atómica), 01N (el libro solo lee). Aditiva: sin UPDATE/DELETE
-- de datos de negocio, sin backfill. "NO cancela las reservas futuras"
-- (EKKO-057) se conserva.
-- ============================================================================

-- ── 0. Ventana de cancelación: UNA fuente en el servidor ─────────────────────
-- config.reserva.cancelacion_min_horas_antes del estudio. Si falta la clave, 24
-- (el default publicado en Admin → Reglas y el valor de EKKO en producción);
-- antes cada lugar suponía algo distinto (RPC y trigger 0, pantalla 24).
CREATE OR REPLACE FUNCTION _cancelacion_min_horas(p_tenant_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE WHEN (t.config->'reserva'->>'cancelacion_min_horas_antes') ~ '^\d+(\.\d+)?$'
                THEN (t.config->'reserva'->>'cancelacion_min_horas_antes')::numeric END
    FROM tenants t WHERE t.id = p_tenant_id
  ), 24);
$$;
REVOKE ALL ON FUNCTION _cancelacion_min_horas(uuid) FROM PUBLIC, anon, authenticated;

-- Frontera (única): A TIEMPO si faltan MÁS de N horas; TARDE si faltan N o menos
-- (la igualdad exacta es tarde).
CREATE OR REPLACE FUNCTION _cancelacion_tardia(p_tenant_id uuid, p_slot_inicio timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_slot_inicio <= now() + make_interval(secs => _cancelacion_min_horas(p_tenant_id) * 3600);
$$;
REVOKE ALL ON FUNCTION _cancelacion_tardia(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── 1. Causa de la cancelación, explícita en la reserva ──────────────────────
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS cancelacion_causa text,
  ADD COLUMN IF NOT EXISTS cancelacion_tardia boolean;
COMMENT ON COLUMN reservas.cancelacion_causa IS
  'R2-B/01Q: quién causó la cancelación: miembro (status cancelada) o estudio (status cancelada_admin). NULL = histórica.';
COMMENT ON COLUMN reservas.cancelacion_tardia IS
  'R2-B/01Q: la cancelación a petición del miembro ocurrió dentro de la ventana (faltaban N horas o menos): el crédito no se devuelve.';
ALTER TABLE reservas
  ADD CONSTRAINT reservas_cancelacion_causa_check CHECK (
    cancelacion_causa IS NULL
    OR (cancelacion_causa = 'miembro' AND status = 'cancelada')
    OR (cancelacion_causa = 'estudio' AND status = 'cancelada_admin')
  ) NOT VALID;
ALTER TABLE reservas VALIDATE CONSTRAINT reservas_cancelacion_causa_check;

-- El status ES la causa (cancelada = miembro, cancelada_admin = estudio) para
-- CUALQUIER camino de servidor (RPC, reprogramación, estudio fuera de servicio).
-- Aquí se asienta y se calcula la tardanza con la ventana canónica.
CREATE OR REPLACE FUNCTION reservas_normalizar_cancelacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.cancelacion_causa := CASE NEW.status WHEN 'cancelada' THEN 'miembro' ELSE 'estudio' END;
  NEW.cancelacion_tardia := (NEW.cancelacion_causa = 'miembro'
                             AND _cancelacion_tardia(NEW.tenant_id, NEW.slot_inicio));
  NEW.cancelada_at := COALESCE(NEW.cancelada_at, now());
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reservas_normalizar_cancelacion() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_normalizar_cancelacion ON reservas;
CREATE TRIGGER trg_normalizar_cancelacion
  BEFORE UPDATE OF status ON reservas
  FOR EACH ROW
  WHEN (OLD.status = 'confirmada' AND NEW.status IN ('cancelada', 'cancelada_admin'))
  EXECUTE FUNCTION reservas_normalizar_cancelacion();

-- ── 2. Revisiones humanas de reserva (créditos sin destino, extras pagados) ──
ALTER TABLE revisiones_financieras
  DROP CONSTRAINT revisiones_financieras_tipo_check,
  ADD CONSTRAINT revisiones_financieras_tipo_check CHECK (tipo IN (
    'reembolso', 'disputa_abierta', 'disputa_perdida', 'origen_no_resuelto', 'origen_ambiguo',
    'reconciliacion_reembolso', 'cuenta_desautorizada', 'vinculo_valor_pendiente',
    'invitados_extra_no_aplicado',
    'credito_no_restaurado', 'extras_pagados_reserva_cancelada'
  ));

CREATE OR REPLACE FUNCTION _avisar_admins(p_tenant_id uuid, p_tipo text, p_titulo text, p_mensaje text, p_metadata jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  SELECT p_tenant_id, u.id, p_tipo, p_titulo, p_mensaje, p_metadata
  FROM usuarios u
  WHERE u.tenant_id = p_tenant_id AND u.rol = 'admin' AND u.status = 'activo';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION _avisar_admins(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- UNA revisión por (tipo, reserva), abierta o ya resuelta: un reintento no la duplica.
CREATE OR REPLACE FUNCTION _abrir_revision_reserva(
  p_tenant_id uuid, p_tipo text, p_reserva_id uuid, p_detalle jsonb, p_titulo text, p_mensaje text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM revisiones_financieras
             WHERE tenant_id = p_tenant_id AND tipo = p_tipo AND reversal_id IS NULL
               AND referencia = p_reserva_id::text) THEN
    RETURN false;
  END IF;
  INSERT INTO revisiones_financieras (tenant_id, tipo, referencia, detalle)
  VALUES (p_tenant_id, p_tipo, p_reserva_id::text, p_detalle)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM _avisar_admins(p_tenant_id, 'revision_financiera', p_titulo, p_mensaje,
                         jsonb_build_object('revision_id', v_id, 'tipo', p_tipo, 'reserva_id', p_reserva_id, 'url', '/admin/cobros'));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION _abrir_revision_reserva(uuid, text, uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;

-- ── 3. Devolución de créditos al cancelar (cuerpo de 20260920160000:119) ─────
-- Cambios R2-B:
--   · La regla sale de la causa asentada en la reserva (01Q): solo la
--     cancelación TARDÍA a petición del miembro consume el crédito.
--   · Sin destino válido (la membresía que pagó ya terminó y no hay otra viva
--     con saldo de créditos) → revisión `credito_no_restaurado` (D-01O-1). Antes:
--     RETURN silencioso. No se resucita ni se crea ninguna membresía.
--   · Plan por tiempo: nunca hubo débito → no se fabrica ningún movimiento.
CREATE OR REPLACE FUNCTION creditos_devolver_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem        membresias;
  v_debito     integer;  -- delta del débito (negativo)
  v_debito_mem uuid;     -- membresía que pagó la reserva
  v_debito_id  uuid;
  v_devolver   integer;  -- monto a devolver (positivo)
  v_origen     membresias;
BEGIN
  IF NOT (OLD.status = 'confirmada' AND NEW.status IN ('cancelada', 'cancelada_admin')) THEN
    RETURN NEW;
  END IF;

  -- Monto realmente debitado por esta reserva (si lo hubo y no se devolvió ya).
  SELECT id, delta, membresia_id INTO v_debito_id, v_debito, v_debito_mem
  FROM membresia_movimientos
  WHERE reserva_id = NEW.id AND tipo = 'debito'
  LIMIT 1;

  IF v_debito IS NULL THEN
    RETURN NEW;  -- no hubo débito (plan por tiempo)
  END IF;
  IF EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = NEW.id AND tipo = 'devolucion') THEN
    RETURN NEW;
  END IF;

  -- El miembro que cancela tarde pierde el crédito; a tiempo o si cancela el
  -- estudio, se devuelve. La tardanza la asentó trg_normalizar_cancelacion.
  IF NEW.cancelacion_causa = 'miembro' AND COALESCE(NEW.cancelacion_tardia, false) THEN
    RETURN NEW;
  END IF;

  v_devolver := -v_debito;  -- ej. débito -2 → devuelve 2

  -- D10: primero la membresía que se debitó, si sigue viva o en pausa…
  SELECT m.* INTO v_mem
  FROM membresias m
  WHERE m.id = v_debito_mem
    AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
  FOR UPDATE;

  -- …si ya no (se reemplazó por otro plan), la viva actual del miembro.
  IF v_mem.id IS NULL THEN
    SELECT m.* INTO v_mem
    FROM membresias m
    WHERE m.usuario_id = NEW.usuario_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
    ORDER BY m.created_at DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_mem.id IS NULL OR v_mem.creditos_restantes IS NULL THEN
    -- D-01O-1: no hay dónde restaurar. Evidencia + UNA revisión humana.
    SELECT * INTO v_origen FROM membresias WHERE id = v_debito_mem;
    PERFORM _abrir_revision_reserva(
      NEW.tenant_id, 'credito_no_restaurado', NEW.id,
      jsonb_build_object(
        'reserva_id', NEW.id, 'folio', NEW.folio, 'usuario_id', NEW.usuario_id,
        'movimiento_debito_id', v_debito_id, 'membresia_id', v_debito_mem,
        'membresia_status', v_origen.status, 'creditos', v_devolver,
        'causa_cancelacion', NEW.cancelacion_causa,
        'razon', CASE WHEN v_mem.id IS NULL THEN 'derecho_terminado' ELSE 'membresia_viva_sin_creditos' END,
        'efecto_automatico', 'ninguno'),
      'Crédito sin restaurar',
      'Se canceló la reserva ' || COALESCE(NEW.folio, '') || ' pagada con ' || v_devolver
        || ' crédito(s), pero la membresía del miembro ya terminó y no hay dónde devolverlos. Revísalo en Cobros.'
    );
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

-- ── 4. Invitados extra pagados en una reserva cancelada (D-01Q-2) ────────────
-- DIFERIDO al final de la transacción: una reprogramación cancela la vieja y
-- luego TRASLADA sus extras a la nueva (R2-A); al cierre la vieja ya no tiene
-- extras atribuidos y no se abre revisión. No reembolsa ni toca evidencia.
CREATE OR REPLACE FUNCTION reservas_revision_extras_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res   reservas;
  v_cant  integer;
  v_monto integer;
  v_pagos jsonb;
BEGIN
  SELECT * INTO v_res FROM reservas WHERE id = NEW.id;
  IF v_res.id IS NULL OR v_res.status NOT IN ('cancelada', 'cancelada_admin') THEN
    RETURN NULL;
  END IF;
  v_cant := _extras_atribuidos(v_res.id);
  IF v_cant <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(p.monto_centavos), 0)::integer,
         COALESCE(jsonb_agg(jsonb_build_object('pago_id', p.id, 'stripe_payment_intent_id', p.stripe_payment_intent_id,
                                               'cantidad', p.cantidad, 'monto_centavos', p.monto_centavos,
                                               'moneda', p.moneda) ORDER BY p.created_at, p.id), '[]'::jsonb)
    INTO v_monto, v_pagos
  FROM invitados_extra_pagos p
  WHERE p.estado = 'aplicado'
    AND COALESCE((SELECT t.reserva_destino_id FROM invitados_extra_traslados t
                  WHERE t.pago_id = p.id ORDER BY t.seq DESC LIMIT 1), p.reserva_id) = v_res.id;

  PERFORM _abrir_revision_reserva(
    v_res.tenant_id, 'extras_pagados_reserva_cancelada', v_res.id,
    jsonb_build_object(
      'reserva_id', v_res.id, 'folio', v_res.folio, 'usuario_id', v_res.usuario_id,
      'cantidad', v_cant, 'monto_centavos', v_monto, 'pagos', v_pagos,
      'causa_cancelacion', v_res.cancelacion_causa, 'cancelacion_tardia', v_res.cancelacion_tardia,
      'reembolso_automatico', false),
    'Reserva cancelada con invitados extra pagados',
    'Se canceló la reserva ' || COALESCE(v_res.folio, '') || ' que tenía ' || v_cant
      || ' invitado(s) extra pagado(s). No se hizo ningún reembolso automático: decide en Cobros si procede devolverlo.'
  );
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION reservas_revision_extras_al_cancelar() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_revision_extras_al_cancelar ON reservas;
CREATE CONSTRAINT TRIGGER trg_revision_extras_al_cancelar
  AFTER UPDATE OF status ON reservas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'confirmada' AND NEW.status IN ('cancelada', 'cancelada_admin'))
  EXECUTE FUNCTION reservas_revision_extras_al_cancelar();

-- ── 5. cancelar_reserva_atomic: la causa es explícita (D-01Q-1) ──────────────
-- Firma nueva (p_causa). Se retira la de dos argumentos para que no haya dos
-- funciones candidatas.
--   · Dueño de la reserva: causa = miembro. Tarde → sigue sin poder cancelar por
--     su cuenta (Términos §6: "con menos anticipación, el cambio se acuerda con
--     el estudio").
--   · Recepción/admin: p_causa OBLIGATORIA.
--       'estudio' → cancelada_admin; el crédito vuelve (o revisión, D-01O-1).
--       'miembro' → cancelada (la pidió el miembro; queda quién la ejecutó);
--                   tarde → el crédito NO vuelve; el aviso lo dice.
DROP FUNCTION IF EXISTS cancelar_reserva_atomic(uuid, text);
CREATE OR REPLACE FUNCTION cancelar_reserva_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL,
  p_causa text DEFAULT NULL
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
  v_horas numeric;
  v_debitada boolean;
  v_devuelta boolean;
  v_set text;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH';
  END IF;

  -- R2-A (01I): FOR UPDATE serializa cancelaciones/correcciones concurrentes.
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

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
  v_horas := _cancelacion_min_horas(v_reserva.tenant_id);

  IF NOT v_por_tercero THEN
    -- El miembro cancela lo suyo: solo A TIEMPO (faltan más de N horas).
    IF _cancelacion_tardia(v_reserva.tenant_id, v_reserva.slot_inicio) THEN
      RAISE EXCEPTION 'EKKO_CANCELACION_TARDIA: Ya no puedes cancelar esta reserva por tu cuenta (faltan % horas o menos). Contacta a recepción.', v_horas;
    END IF;

    UPDATE reservas
    SET status = 'cancelada',
        cancelada_at = now(),
        cancelada_motivo = p_motivo
    WHERE id = p_reserva_id
    RETURNING * INTO v_reserva;
    RETURN v_reserva;
  END IF;

  IF p_causa IS NULL OR p_causa NOT IN ('miembro', 'estudio') THEN
    RAISE EXCEPTION 'EKKO_CAUSA_REQUERIDA: Indica si la cancelación la pidió el miembro o la decide el estudio';
  END IF;

  v_debitada := EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = p_reserva_id AND tipo = 'debito');

  IF p_causa = 'estudio' THEN
    UPDATE reservas
    SET status = 'cancelada_admin',
        cancelada_at = now(),
        cancelada_motivo = p_motivo,
        cancelada_por = v_user_id,
        cancelacion_notificada_at = now()
    WHERE id = p_reserva_id
    RETURNING * INTO v_reserva;

    v_devuelta := EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = p_reserva_id AND tipo = 'devolucion');

    -- Hora de pared del ESTUDIO (este texto también se manda por correo).
    v_mensaje := 'Tu reserva del '
      || _fecha_hora_estudio(v_reserva.slot_inicio)
      || ' fue cancelada por el estudio.'
      || CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
              THEN ' Motivo: ' || p_motivo ELSE '' END
      -- El motivo es texto libre: se cierra con punto solo si sigue otra frase.
      || CASE WHEN v_debitada AND p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
                   AND trim(p_motivo) !~ '[.!?]$' THEN '.' ELSE '' END
      || CASE WHEN v_debitada AND v_devuelta THEN ' Tu crédito fue devuelto.'
              WHEN v_debitada THEN ' El crédito de esa sesión no pudo devolverse automáticamente; el estudio lo revisará contigo.'
              ELSE '' END;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_reserva.tenant_id,
      v_reserva.usuario_id,
      'reserva_cancelada',
      'Tu reserva fue cancelada',
      v_mensaje,
      jsonb_build_object('reserva_id', p_reserva_id, 'url', '/app/reservas', 'causa', 'estudio')
    );
    RETURN v_reserva;
  END IF;

  -- A petición del miembro, ejecutada por el equipo.
  UPDATE reservas
  SET status = 'cancelada',
      cancelada_at = now(),
      cancelada_motivo = p_motivo,
      cancelada_por = v_user_id,
      cancelacion_notificada_at = now()
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  v_devuelta := EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = p_reserva_id AND tipo = 'devolucion');

  -- El aviso genérico "Cancelaste tu reserva" (trigger) se reemplaza por uno que
  -- dice quién la ejecutó y qué pasó con el crédito.
  DELETE FROM notificaciones
  WHERE usuario_id = v_reserva.usuario_id AND tipo = 'reserva_cancelada_por_ti'
    AND metadata->>'reserva_id' = p_reserva_id::text;

  SELECT nombre INTO v_set FROM recursos WHERE id = v_reserva.recurso_id;
  v_mensaje := 'A tu solicitud cancelamos ' || COALESCE(v_set, 'tu sesión') || ' del '
    || _fecha_hora_estudio(v_reserva.slot_inicio) || '.'
    || CASE
         WHEN v_debitada AND v_reserva.cancelacion_tardia
           THEN ' Como faltaban ' || v_horas || ' horas o menos, el crédito de esa sesión no se devuelve.'
         WHEN v_debitada AND v_devuelta THEN ' Tu crédito fue devuelto.'
         WHEN v_debitada THEN ' El crédito de esa sesión no pudo devolverse automáticamente; el estudio lo revisará contigo.'
         WHEN v_reserva.cancelacion_tardia THEN ' Por ser una cancelación tardía, la sesión cuenta como usada en tu día.'
         ELSE ''
       END;

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (
    v_reserva.tenant_id, v_reserva.usuario_id, 'reserva_cancelada',
    'Cancelamos tu reserva a tu solicitud', v_mensaje,
    jsonb_build_object('reserva_id', p_reserva_id, 'url', '/app/reservas', 'causa', 'miembro',
                       'tardia', v_reserva.cancelacion_tardia)
  );

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (
    v_reserva.tenant_id, v_user_id, COALESCE(get_my_rol(), 'staff'), 'reserva_cancelada_a_peticion_del_miembro',
    'usuario', v_reserva.usuario_id,
    jsonb_build_object('reserva_status', 'confirmada'),
    jsonb_build_object('reserva_status', 'cancelada', 'causa', 'miembro', 'tardia', v_reserva.cancelacion_tardia,
                       'credito_devuelto', v_devuelta),
    NULLIF(trim(COALESCE(p_motivo, '')), ''),
    jsonb_build_object('reserva_id', v_reserva.id, 'folio', v_reserva.folio, 'recurso_id', v_reserva.recurso_id,
                       'slot_inicio', v_reserva.slot_inicio, 'ventana_horas', v_horas)
  );

  RETURN v_reserva;
END;
$$;
REVOKE ALL ON FUNCTION cancelar_reserva_atomic(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancelar_reserva_atomic(uuid, text, text) TO authenticated;

-- ── 6. No reservar más allá del fin efectivo CONOCIDO del derecho (D-01O-2) ──
-- Aplica a planes por TIEMPO cuyo final se conoce: baja programada al fin del
-- periodo, o membresía que no se renueva sola (mostrador, sin suscripción).
-- Una suscripción que se renueva no tiene fin conocido. Una sesión pagada con
-- CRÉDITOS queda pagada al reservar (Términos §2; la puerta la deja pasar): el
-- crédito consumido es su derecho y no se bloquea aquí.
-- Trigger nuevo (no se recrean las RPC): cubre miembro, recepción y reprogramación.
CREATE OR REPLACE FUNCTION reservas_dentro_de_vigencia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem record;
BEGIN
  SELECT m.periodo_actual_fin, m.cancel_at_period_end, m.stripe_subscription_id, t.tipo
    INTO v_mem
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;  -- sin membresía viva: lo rechaza el débito (EKKO_SIN_MEMBRESIA)
  END IF;

  IF v_mem.tipo = 'tiempo'
     AND v_mem.periodo_actual_fin IS NOT NULL
     AND v_mem.periodo_actual_fin > now()   -- ya vencida: responde el débito (EKKO_MEMBRESIA_VENCIDA)
     AND (COALESCE(v_mem.cancel_at_period_end, false) OR v_mem.stripe_subscription_id IS NULL)
     AND NEW.slot_inicio >= v_mem.periodo_actual_fin THEN
    RAISE EXCEPTION 'EKKO_FUERA_DE_VIGENCIA: La membresía termina el %; no se puede reservar una sesión después de esa fecha. Renueva el plan para reservar más adelante.',
      to_char(v_mem.periodo_actual_fin AT TIME ZONE 'America/Mazatlan', 'DD/MM/YYYY');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reservas_dentro_de_vigencia() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_reserva_dentro_de_vigencia ON reservas;
CREATE TRIGGER trg_reserva_dentro_de_vigencia
  BEFORE INSERT ON reservas
  FOR EACH ROW
  WHEN (NEW.status = 'confirmada')
  EXECUTE FUNCTION reservas_dentro_de_vigencia();

-- ── 7. Funciones existentes con un cambio puntual ────────────────────────────
CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_now timestamptz := now();
  v_pen jsonb;
  v_umbral integer;
  v_bloqueo_dias integer;
  v_antes_count integer;
  v_antes_bloqueo timestamptz;
  v_despues_count integer;
  v_despues_bloqueo timestamptz;
  v_bloquea boolean;
  v_titulo text;
  v_mensaje text;
  v_restantes integer;
  r record;
  v_estado text;
BEGIN
  FOR r IN
    SELECT res.id, res.usuario_id, res.tenant_id, res.folio, t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      -- +60 min: alineado con la ventana del check-in manual.
      AND res.slot_fin + interval '60 minutes' < v_now
  LOOP
    -- Config del tenant, tolerante a basura (solo enteros no negativos).
    v_pen := COALESCE(r.tenant_config->'penalizaciones', '{}'::jsonb);
    v_bloqueo_dias := COALESCE(
      CASE WHEN (v_pen->>'no_show_bloqueo_dias') ~ '^\d+$' THEN (v_pen->>'no_show_bloqueo_dias')::integer END,
      7
    );
    v_umbral := GREATEST(1, COALESCE(
      CASE WHEN (v_pen->>'no_show_umbral') ~ '^\d+$' THEN (v_pen->>'no_show_umbral')::integer END,
      3
    ));

    -- R2-A (01I): transición condicionada; si alguien la cambió (check-in tardío,
    -- cancelación) entre el SELECT y aquí, no se pisa ni se penaliza.
    UPDATE reservas SET status = 'no_show'
    WHERE id = r.id AND status = 'confirmada' AND check_in_at IS NULL;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    -- R2-B (01O): si EKKO mismo hizo imposible la asistencia (cuenta revocada o
    -- sancionada, o derecho terminado: sin membresía, vencida, cuenta sin
    -- acceso), la falta se registra SIN penalización: ni contador, ni bloqueo,
    -- ni aviso de inasistencia. Una sesión pagada con créditos sí podía entrar
    -- ('ok') y un cobro pendiente es del miembro: esas se penalizan como antes.
    v_estado := _estado_membresia_checkin(r.usuario_id, r.id);
    IF v_estado NOT IN ('ok', 'pago_pendiente') THEN
      INSERT INTO audit_log (
        tenant_id, actor_usuario_id, actor_rol, accion,
        target_tipo, target_id, antes, despues, metadata
      ) VALUES (
        r.tenant_id, NULL, 'service_role', 'no_show_sin_penalizacion',
        'usuario', r.usuario_id,
        jsonb_build_object('reserva_status', 'confirmada'),
        jsonb_build_object('reserva_status', 'no_show', 'acceso', v_estado),
        jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'motivo', 'asistencia_imposible_por_ekko')
      );
      CONTINUE;
    END IF;

    SELECT no_shows_count, bloqueado_hasta
      INTO v_antes_count, v_antes_bloqueo
      FROM usuarios WHERE id = r.usuario_id;

    v_bloquea := v_bloqueo_dias > 0 AND (COALESCE(v_antes_count, 0) + 1) >= v_umbral;

    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = CASE
          WHEN v_bloquea
          THEN GREATEST(COALESCE(bloqueado_hasta, v_now), v_now) + (v_bloqueo_dias || ' days')::interval
          ELSE bloqueado_hasta
        END
    WHERE id = r.usuario_id
    RETURNING no_shows_count, bloqueado_hasta INTO v_despues_count, v_despues_bloqueo;

    IF v_bloquea THEN
      v_usuarios_bloqueados := v_usuarios_bloqueados + 1;
    END IF;

    -- Aviso al miembro (mismo texto que _lib/noShow.ts).
    IF v_bloquea THEN
      v_titulo := 'Cuenta bloqueada por inasistencia';
      v_mensaje := format(
        'No llegaste a tu sesión reservada (%s). Llevas %s de %s faltas permitidas. Tu cuenta queda bloqueada para reservar hasta el %s.',
        COALESCE(r.folio, 'sin folio'), v_despues_count, v_umbral,
        to_char(v_despues_bloqueo AT TIME ZONE 'America/Mazatlan', 'DD/MM')
      );
    ELSE
      v_restantes := GREATEST(0, v_umbral - v_despues_count);
      v_titulo := 'Registramos una inasistencia';
      v_mensaje := format(
        'No llegaste a tu sesión reservada (%s). Llevas %s de %s faltas permitidas.%s',
        COALESCE(r.folio, 'sin folio'), v_despues_count, v_umbral,
        CASE
          WHEN v_bloqueo_dias > 0 AND v_restantes > 0 THEN
            format(' Si faltas %s, tu cuenta se bloquea %s días.',
              CASE WHEN v_restantes = 1 THEN 'una vez más' ELSE v_restantes || ' veces más' END,
              v_bloqueo_dias)
          ELSE ''
        END
      );
    END IF;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      r.tenant_id, r.usuario_id, 'no_show', v_titulo, v_mensaje,
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'bloqueado_hasta', v_despues_bloqueo)
    );

    INSERT INTO audit_log (
      tenant_id, actor_usuario_id, actor_rol, accion,
      target_tipo, target_id, antes, despues, metadata
    ) VALUES (
      r.tenant_id, NULL, 'service_role', 'no_show_cron',
      'usuario', r.usuario_id,
      jsonb_build_object('reserva_status', 'confirmada', 'no_shows_count', v_antes_count, 'bloqueado_hasta', v_antes_bloqueo),
      jsonb_build_object('reserva_status', 'no_show', 'no_shows_count', v_despues_count, 'bloqueado_hasta', v_despues_bloqueo),
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'umbral', v_umbral, 'bloqueo_dias', v_bloqueo_dias)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION reservar_recurso_atomic(
  p_recurso_id uuid,
  p_slot_inicio timestamptz,
  p_duracion_min integer,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_usuario usuarios;
  v_recurso recursos;
  v_tenant tenants;
  v_slot_fin timestamptz;
  v_now timestamptz := now();
  v_min_anticipacion_h integer;
  v_permitir_continuas boolean;
  v_max_invitados integer;
  v_existe_continua boolean;
  v_existe_doble boolean;
  v_dia_semana text;
  v_slot_dentro_horario boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
  v_max_sesiones_dia integer;
  v_sesiones_hoy integer;
  v_cancel_min_h numeric;
  v_tier tiers;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  -- FOR UPDATE: serializa las reservas concurrentes del mismo miembro (para que
  -- el tope diario y "horas continuas" cuenten bien ante dos submits a la vez).
  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id FOR UPDATE;
  SELECT * INTO v_recurso FROM recursos WHERE id = p_recurso_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'EKKO_USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_recurso IS NULL OR v_recurso.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: Estudio no encontrado';
  END IF;

  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'EKKO_RECURSO_INACTIVO: Este estudio no está disponible';
  END IF;

  -- R2-A (01K): el plan sale de la membresía VIVA, nunca de usuarios.membresia_tier
  -- (caché de display). Sin membresía viva: EKKO_SIN_MEMBRESIA (el mismo error
  -- que daba el trigger de débito, ahora antes de la puerta de plan).
  v_tier := _tier_vivo(v_user_id);
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: No hay un plan vigente. Se necesita un plan o paquete para reservar.';
  END IF;
  -- Gate de plan en UN solo lugar (_recurso_permite_tier): lista vacía = abierto.
  IF NOT _recurso_permite_tier(v_recurso.tiers_permitidos, v_tier.slug) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: Tu plan no tiene acceso a este estudio';
  END IF;

  -- R2-A (01K/01M): tope de invitados del plan VIVO; reglas.max_invitados es
  -- obligatorio (CHECK en tiers), sin fallbacks legados por slug.
  v_max_invitados := COALESCE((v_tier.reglas->>'max_invitados')::integer, 0);

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24
  );

  IF p_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  IF v_recurso.horarios IS NOT NULL AND jsonb_array_length(v_recurso.horarios) > 0 THEN
    v_dia_semana := CASE EXTRACT(DOW FROM (p_slot_inicio AT TIME ZONE 'America/Mazatlan'))::integer
      WHEN 0 THEN 'domingo'
      WHEN 1 THEN 'lunes'
      WHEN 2 THEN 'martes'
      WHEN 3 THEN 'miercoles'
      WHEN 4 THEN 'jueves'
      WHEN 5 THEN 'viernes'
      WHEN 6 THEN 'sabado'
    END;

    SELECT EXISTS(
      SELECT 1
      FROM jsonb_array_elements(v_recurso.horarios) AS bloque
      WHERE bloque->>'dia' = v_dia_semana
        AND (bloque->>'inicio')::time <= (p_slot_inicio AT TIME ZONE 'America/Mazatlan')::time
        AND (bloque->>'fin')::time   >= (v_slot_fin    AT TIME ZONE 'America/Mazatlan')::time
    ) INTO v_slot_dentro_horario;

    IF NOT v_slot_dentro_horario THEN
      RAISE EXCEPTION 'EKKO_FUERA_DE_HORARIO: Este horario no está disponible para este estudio';
    END IF;
  END IF;

  v_permitir_continuas := COALESCE(
    (v_tenant.config->'reserva'->>'permitir_continuas')::boolean,
    (v_tenant.config->>'permitir_continuas')::boolean,
    false
  );

  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada', 'completada')
        AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;

    IF v_existe_continua THEN
      RAISE EXCEPTION 'EKKO_CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  v_max_sesiones_dia := COALESCE((v_tenant.config->'reserva'->>'max_sesiones_por_dia')::integer, 0);

  IF v_max_sesiones_dia > 0 THEN
    -- Cuentan también el no_show y la cancelación TARDÍA (dentro de la ventana
    -- de cancelación): antes liberaban el día y se re-reservaba gratis.
    -- R2-B (01Q): la ventana sale de la fuente única del servidor.
    v_cancel_min_h := _cancelacion_min_horas(v_tenant_id);
    SELECT count(*) INTO v_sesiones_hoy
    FROM reservas
    WHERE usuario_id = v_user_id
      AND (
        status IN ('confirmada', 'completada', 'no_show')
        OR (status = 'cancelada' AND v_cancel_min_h > 0 AND cancelada_at IS NOT NULL
            AND cancelada_at > slot_inicio - (v_cancel_min_h || ' hours')::interval)
      )
      AND (slot_inicio AT TIME ZONE 'America/Mazatlan')::date
          = (p_slot_inicio AT TIME ZONE 'America/Mazatlan')::date;

    IF v_sesiones_hoy >= v_max_sesiones_dia THEN
      RAISE EXCEPTION 'EKKO_LIMITE_DIARIO: Ya tienes el máximo de % sesión(es) por día', v_max_sesiones_dia;
    END IF;
  END IF;

  -- Chequeo de solape (rápido, para el mensaje amigable en el caso común).
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE recurso_id = p_recurso_id
      AND status IN ('confirmada', 'completada')
      AND tstzrange(slot_inicio, slot_fin, '[)') && tstzrange(p_slot_inicio, v_slot_fin, '[)')
  ) INTO v_existe_doble;

  IF v_existe_doble THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  -- Red dura: si dos carreras pasaron el SELECT, el EXCLUDE gist rechaza el 2º
  -- INSERT → se traduce a EKKO_SLOT_OCUPADO en vez del error crudo del constraint.
  BEGIN
    INSERT INTO reservas (
      tenant_id, recurso_id, usuario_id,
      slot_inicio, slot_fin, duracion_min,
      invitados_count, status, folio, notas
    ) VALUES (
      v_tenant_id, p_recurso_id, v_user_id,
      p_slot_inicio, v_slot_fin, p_duracion_min,
      p_invitados, 'confirmada', v_folio_nuevo, p_notas
    ) RETURNING id INTO v_reserva_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo
  );
END;
$$;

-- ── 8. Operaciones de cobro en Stripe con evidencia durable (01P) ────────────
-- Sancionar, levantar la sanción, revocar y dar de baja de inmediato dejan aquí
-- la operación que DEBE ocurrir en Stripe, en la MISMA transacción que el cambio
-- en EKKO. La ejecuta el servidor (Netlify) y aquí queda el resultado. Si Stripe
-- falla, el estado de EKKO no se deshace: la fila queda `fallida` y se reintenta.
-- Sin secretos, sin payload del proveedor, sin PII.
CREATE TABLE IF NOT EXISTS stripe_operaciones_suscripcion (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  usuario_id              uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  membresia_id            uuid REFERENCES membresias(id) ON DELETE SET NULL,
  stripe_subscription_id  text NOT NULL,
  tipo                    text NOT NULL CHECK (tipo IN ('suspender_cobro', 'reanudar_cobro', 'cancelar_suscripcion')),
  causa                   text NOT NULL CHECK (causa IN ('sancion', 'levantar_sancion', 'revocacion', 'baja_inmediata')),
  -- Identidad de negocio: UNA fila por operación lógica (reintentos = misma fila).
  operation_key           text NOT NULL UNIQUE,
  estado                  text NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente', 'aplicada', 'fallida', 'descartada')),
  intentos                integer NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_error            text,
  motivo_descarte         text,
  resultado               jsonb NOT NULL DEFAULT '{}'::jsonb,   -- estado del proveedor (status, pausa); sin PII
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  ultimo_intento_at       timestamptz,
  aplicada_at             timestamptz
);
CREATE INDEX IF NOT EXISTS stripe_operaciones_suscripcion_pendientes_idx
  ON stripe_operaciones_suscripcion (created_at) WHERE estado IN ('pendiente', 'fallida');
CREATE INDEX IF NOT EXISTS stripe_operaciones_suscripcion_usuario_idx
  ON stripe_operaciones_suscripcion (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stripe_operaciones_suscripcion_membresia_idx
  ON stripe_operaciones_suscripcion (membresia_id, aplicada_at DESC);
COMMENT ON TABLE stripe_operaciones_suscripcion IS
  'R2-B/01P: operaciones de cobro que EKKO debe aplicar en Stripe (suspender, reanudar, cancelar) con su resultado. Evidencia durable y reintentable; una fila por operación lógica.';

CREATE OR REPLACE FUNCTION stripe_operaciones_suscripcion_guardia()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INMUTABLE: La evidencia de una operación de cobro no se borra';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.stripe_subscription_id <> OLD.stripe_subscription_id
     OR NEW.tipo <> OLD.tipo OR NEW.causa <> OLD.causa OR NEW.operation_key <> OLD.operation_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INMUTABLE: La identidad de una operación de cobro no cambia';
  END IF;
  -- Lo aplicado en el proveedor es un hecho: no vuelve atrás.
  IF OLD.estado = 'aplicada' AND NEW.estado <> 'aplicada' THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INMUTABLE: Una operación aplicada no cambia de estado';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION stripe_operaciones_suscripcion_guardia() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_stripe_operaciones_suscripcion_guardia ON stripe_operaciones_suscripcion;
CREATE TRIGGER trg_stripe_operaciones_suscripcion_guardia
  BEFORE UPDATE OR DELETE ON stripe_operaciones_suscripcion
  FOR EACH ROW EXECUTE FUNCTION stripe_operaciones_suscripcion_guardia();

ALTER TABLE stripe_operaciones_suscripcion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stripe_operaciones_suscripcion_admin_read ON stripe_operaciones_suscripcion;
CREATE POLICY stripe_operaciones_suscripcion_admin_read ON stripe_operaciones_suscripcion
  FOR SELECT TO authenticated USING (tenant_id = get_my_tenant_id() AND is_admin());
REVOKE INSERT, UPDATE, DELETE ON stripe_operaciones_suscripcion FROM anon, authenticated;

-- Estado deseado del cobro por SANCIÓN, por membresía del miembro:
--   sancionado (y no revocado) → cobro suspendido;  si no → cobro normal.
-- Compara contra lo último APLICADO en el proveedor y deja la operación que falta.
-- Idempotente: llamarla N veces no crea operaciones contradictorias.
CREATE OR REPLACE FUNCTION _reconciliar_cobro_sancion(p_usuario_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_u        usuarios;
  v_m        record;
  v_ultima   record;
  v_creadas  integer := 0;
  v_n        integer;
BEGIN
  SELECT * INTO v_u FROM usuarios WHERE id = p_usuario_id;
  IF v_u.id IS NULL THEN
    RETURN 0;
  END IF;

  -- Revocada: la suscripción se CANCELA (otra operación); suspender/reanudar sobran.
  IF v_u.status = 'revocado' THEN
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'descartada', motivo_descarte = 'cuenta_revocada'
    WHERE usuario_id = p_usuario_id AND tipo IN ('suspender_cobro', 'reanudar_cobro')
      AND estado IN ('pendiente', 'fallida');
    RETURN 0;
  END IF;

  FOR v_m IN
    SELECT m.id, m.tenant_id, m.status, m.stripe_subscription_id
    FROM membresias m
    WHERE m.usuario_id = p_usuario_id AND m.stripe_subscription_id IS NOT NULL
      AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
  LOOP
    SELECT o.id, o.tipo INTO v_ultima
    FROM stripe_operaciones_suscripcion o
    WHERE o.membresia_id = v_m.id AND o.tipo IN ('suspender_cobro', 'reanudar_cobro') AND o.estado = 'aplicada'
    ORDER BY o.aplicada_at DESC, o.created_at DESC
    LIMIT 1;

    IF v_u.sancionado_at IS NOT NULL THEN
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'sancion_vigente'
      WHERE membresia_id = v_m.id AND tipo = 'reanudar_cobro' AND estado IN ('pendiente', 'fallida');

      -- Solo se suspende lo que EKKO no tenía ya en pausa por otra razón.
      IF v_ultima.tipo IS DISTINCT FROM 'suspender_cobro'
         AND v_m.status IN ('trialing', 'activa', 'past_due')
         AND NOT EXISTS (SELECT 1 FROM stripe_operaciones_suscripcion
                         WHERE membresia_id = v_m.id AND tipo = 'suspender_cobro' AND estado IN ('pendiente', 'fallida')) THEN
        INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
        VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'suspender_cobro', 'sancion',
                'suspender:' || v_m.id || ':' || floor(extract(epoch FROM v_u.sancionado_at) * 1000)::bigint)
        ON CONFLICT (operation_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_creadas := v_creadas + v_n;
      END IF;
    ELSE
      -- Sin sanción: una suspensión que no llegó a aplicarse ya no hace falta.
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'sancion_levantada'
      WHERE membresia_id = v_m.id AND tipo = 'suspender_cobro' AND estado IN ('pendiente', 'fallida');

      -- Y si lo último aplicado fue una suspensión, se reanuda (una vez por suspensión).
      IF v_ultima.tipo = 'suspender_cobro' THEN
        INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
        VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'reanudar_cobro', 'levantar_sancion',
                'reanudar:' || v_ultima.id)
        ON CONFLICT (operation_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_creadas := v_creadas + v_n;
      END IF;
    END IF;
  END LOOP;
  RETURN v_creadas;
END;
$$;
REVOKE ALL ON FUNCTION _reconciliar_cobro_sancion(uuid) FROM PUBLIC, anon, authenticated;

-- Sanción / revocación → operación de cobro, en la misma transacción.
CREATE OR REPLACE FUNCTION usuarios_operaciones_cobro()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Revocación: TERMINAL. Cancelar de inmediato cada suscripción viva del miembro.
  IF NEW.status = 'revocado' AND OLD.status IS DISTINCT FROM 'revocado' THEN
    INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
    SELECT m.tenant_id, NEW.id, m.id, m.stripe_subscription_id, 'cancelar_suscripcion', 'revocacion', 'cancelar:' || m.id
    FROM membresias m
    WHERE m.usuario_id = NEW.id AND m.stripe_subscription_id IS NOT NULL
      AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
    ON CONFLICT (operation_key) DO NOTHING;
  END IF;

  PERFORM _reconciliar_cobro_sancion(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION usuarios_operaciones_cobro() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_usuarios_operaciones_cobro ON usuarios;
CREATE TRIGGER trg_usuarios_operaciones_cobro
  AFTER UPDATE OF status, sancionado_at ON usuarios
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.sancionado_at IS DISTINCT FROM OLD.sancionado_at)
  EXECUTE FUNCTION usuarios_operaciones_cobro();

-- Baja INMEDIATA hecha por EKKO (no por un evento de Stripe: esos mueven
-- last_sub_event_at): la suscripción debe cancelarse en el proveedor. Antes, si
-- la llamada fallaba, solo quedaba un reporte en Sentry.
CREATE OR REPLACE FUNCTION membresias_operacion_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
  VALUES (NEW.tenant_id, NEW.usuario_id, NEW.id, NEW.stripe_subscription_id, 'cancelar_suscripcion', 'baja_inmediata', 'cancelar:' || NEW.id)
  ON CONFLICT (operation_key) DO NOTHING;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'descartada', motivo_descarte = 'membresia_cancelada'
  WHERE membresia_id = NEW.id AND tipo IN ('suspender_cobro', 'reanudar_cobro') AND estado IN ('pendiente', 'fallida');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION membresias_operacion_cancelar() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_membresias_operacion_cancelar ON membresias;
CREATE TRIGGER trg_membresias_operacion_cancelar
  AFTER UPDATE OF status ON membresias
  FOR EACH ROW
  WHEN (NEW.status = 'cancelada'
        AND OLD.status IN ('trialing', 'activa', 'past_due', 'pausada')
        AND NEW.stripe_subscription_id IS NOT NULL
        AND NEW.last_sub_event_at IS NOT DISTINCT FROM OLD.last_sub_event_at)
  EXECUTE FUNCTION membresias_operacion_cancelar();

-- Paso 1 del ejecutor: tomar la operación y REVALIDAR contra el estado actual.
-- Devuelve si hay que llamar a Stripe; si ya no procede, la descarta con motivo.
CREATE OR REPLACE FUNCTION operacion_suscripcion_preparar(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o       stripe_operaciones_suscripcion;
  v_u       usuarios;
  v_m       membresias;
  v_motivo  text;
BEGIN
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_id FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  IF v_o.estado NOT IN ('pendiente', 'fallida') THEN
    RETURN jsonb_build_object('ejecutar', false, 'estado', v_o.estado, 'motivo', 'ya_' || v_o.estado);
  END IF;

  SELECT * INTO v_u FROM usuarios WHERE id = v_o.usuario_id;
  SELECT * INTO v_m FROM membresias WHERE id = v_o.membresia_id;

  IF v_o.tipo = 'suspender_cobro' THEN
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NULL THEN 'sancion_levantada'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSIF v_o.tipo = 'reanudar_cobro' THEN
    -- No se resucita nada: solo se reanuda si TODO sigue siendo válido.
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NOT NULL THEN 'sancion_vigente'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSE
    -- cancelar: no tocar una suscripción que hoy sostiene OTRA membresía viva.
    v_motivo := CASE
      WHEN EXISTS (SELECT 1 FROM membresias x
                   WHERE x.stripe_subscription_id = v_o.stripe_subscription_id
                     AND x.id IS DISTINCT FROM v_o.membresia_id
                     AND x.status IN ('trialing', 'activa', 'past_due', 'pausada'))
        THEN 'suscripcion_en_uso_por_otra_membresia'
    END;
  END IF;

  IF v_motivo IS NOT NULL THEN
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'descartada', motivo_descarte = v_motivo
    WHERE id = v_o.id;
    RETURN jsonb_build_object('ejecutar', false, 'estado', 'descartada', 'motivo', v_motivo);
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET intentos = intentos + 1, ultimo_intento_at = now()
  WHERE id = v_o.id
  RETURNING * INTO v_o;

  RETURN jsonb_build_object(
    'ejecutar', true, 'id', v_o.id, 'tipo', v_o.tipo, 'tenant_id', v_o.tenant_id,
    'stripe_subscription_id', v_o.stripe_subscription_id,
    -- Llave de idempotencia del proveedor: misma operación + mismo intento.
    'idempotency_key', 'ekko:' || v_o.operation_key || ':' || v_o.intentos,
    'intento', v_o.intentos);
END;
$$;
REVOKE ALL ON FUNCTION operacion_suscripcion_preparar(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION operacion_suscripcion_preparar(uuid) TO service_role;

-- Paso 2: asentar el resultado del proveedor. El primer fallo avisa a los admins.
CREATE OR REPLACE FUNCTION operacion_suscripcion_resultado(p_id uuid, p_ok boolean, p_error text, p_resultado jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o stripe_operaciones_suscripcion;
BEGIN
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_id FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  IF v_o.estado = 'aplicada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', true);
  END IF;

  IF p_ok THEN
    -- Aunque EKKO la hubiera descartado mientras estaba en vuelo: el proveedor la
    -- aplicó y eso es lo que queda asentado.
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'aplicada', aplicada_at = now(), ultimo_error = NULL,
        resultado = COALESCE(p_resultado, '{}'::jsonb)
    WHERE id = v_o.id;
    -- Encadena lo que falte (p. ej. se levantó la sanción mientras se suspendía).
    IF v_o.tipo IN ('suspender_cobro', 'reanudar_cobro') AND v_o.usuario_id IS NOT NULL THEN
      PERFORM _reconciliar_cobro_sancion(v_o.usuario_id);
    END IF;
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', false);
  END IF;

  IF v_o.estado = 'descartada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'descartada');
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'fallida', ultimo_error = left(COALESCE(p_error, 'error_desconocido'), 300),
      resultado = COALESCE(p_resultado, resultado)
  WHERE id = v_o.id;

  IF v_o.estado = 'pendiente' THEN
    PERFORM _avisar_admins(
      v_o.tenant_id, 'stripe_revision',
      'Stripe no aplicó un cambio de cobro',
      CASE v_o.tipo
        WHEN 'suspender_cobro' THEN 'No se pudo SUSPENDER el cobro de un miembro sancionado. La sanción sigue vigente; el cobro se reintentará.'
        WHEN 'reanudar_cobro' THEN 'No se pudo REANUDAR el cobro de un miembro al que se le levantó la sanción. Se reintentará.'
        ELSE 'No se pudo CANCELAR en Stripe la suscripción de una cuenta dada de baja o revocada. El acceso sigue bloqueado; se reintentará.'
      END,
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id, 'url', '/admin/miembros/' || COALESCE(v_o.usuario_id::text, '')));
  END IF;
  RETURN jsonb_build_object('success', true, 'estado', 'fallida');
END;
$$;
REVOKE ALL ON FUNCTION operacion_suscripcion_resultado(uuid, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION operacion_suscripcion_resultado(uuid, boolean, text, jsonb) TO service_role;
