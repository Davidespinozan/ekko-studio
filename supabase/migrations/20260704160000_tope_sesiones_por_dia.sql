-- ============================================================================
-- Tope de sesiones por día por miembro (editable desde admin)
-- ----------------------------------------------------------------------------
-- "Graba todos los días" sobre estudios escasos (1 reserva/slot) necesita un
-- guardrail: un miembro no debe acaparar varios slots el mismo día. El tope
-- vive en config.reserva.max_sesiones_por_dia (lo edita el admin en Reglas):
--   0 o ausente = sin tope · N = máximo N sesiones por día (calendario Culiacán).
--
-- Se re-crea reservar_recurso_atomic (cuerpo vigente 20260522100000) con SOLO
-- el bloque nuevo del tope; el resto es idéntico. Aplica al auto-servicio del
-- miembro; la reserva por recepción (staff) no pasa por aquí a propósito.
--
-- EKKO arranca con tope = 1 (una sesión al día = "graba todos los días").
-- Idempotente (CREATE OR REPLACE + jsonb_set).
-- ============================================================================

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
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id;
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

  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: Tu plan no tiene acceso a este estudio';
  END IF;

  -- max_invitados: leer de tiers.reglas (fallback a CASE hardcoded)
  SELECT COALESCE(
    (t.reglas->>'max_invitados')::integer,
    CASE v_usuario.membresia_tier
      WHEN 'pro' THEN 4
      WHEN 'basica' THEN 2
      ELSE 0
    END
  )
  INTO v_max_invitados
  FROM tiers t
  WHERE t.tenant_id = v_tenant_id
    AND t.slug = v_usuario.membresia_tier;

  IF v_max_invitados IS NULL THEN
    v_max_invitados := CASE v_usuario.membresia_tier
      WHEN 'pro' THEN 4
      WHEN 'basica' THEN 2
      ELSE 0
    END;
  END IF;

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  -- Anticipación mínima: leer config con path anidado + fallback
  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24
  );

  IF p_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  -- ============================================================
  -- Horario del recurso: el slot debe caer dentro de un bloque del día.
  -- LOGIC-FIX L-01: día y hora calculados en hora de Culiacán
  -- ('America/Mazatlan'), no en la timezone de la sesión Postgres.
  -- ============================================================
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

  -- Reservas continuas: respetar flag del tenant.config
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

  -- ============================================================
  -- Tope de sesiones por día (config.reserva.max_sesiones_por_dia).
  -- 0 o ausente = sin tope. Cuenta las reservas vivas del miembro ese mismo día
  -- (calendario de Culiacán). Guardrail de capacidad para "graba todos los días".
  -- ============================================================
  v_max_sesiones_dia := COALESCE((v_tenant.config->'reserva'->>'max_sesiones_por_dia')::integer, 0);

  IF v_max_sesiones_dia > 0 THEN
    SELECT count(*) INTO v_sesiones_hoy
    FROM reservas
    WHERE usuario_id = v_user_id
      AND status IN ('confirmada', 'completada')
      AND (slot_inicio AT TIME ZONE 'America/Mazatlan')::date
          = (p_slot_inicio AT TIME ZONE 'America/Mazatlan')::date;

    IF v_sesiones_hoy >= v_max_sesiones_dia THEN
      RAISE EXCEPTION 'EKKO_LIMITE_DIARIO: Ya tienes el máximo de % sesión(es) por día', v_max_sesiones_dia;
    END IF;
  END IF;

  -- Overlap (slot ya ocupado)
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

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas
  ) VALUES (
    v_tenant_id, p_recurso_id, v_user_id,
    p_slot_inicio, v_slot_fin, p_duracion_min,
    p_invitados, 'confirmada', v_folio_nuevo, p_notas
  ) RETURNING id INTO v_reserva_id;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo
  );
END;
$$;


-- ── EKKO arranca con tope = 1 sesión por día ────────────────────────────────
UPDATE tenants
SET config = jsonb_set(config, '{reserva,max_sesiones_por_dia}', '1'::jsonb, true)
WHERE slug = 'ekko';
