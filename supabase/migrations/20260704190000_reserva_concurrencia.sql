-- ============================================================================
-- Concurrencia de reservas: imposible doblar un estudio o burlar el tope diario
-- ----------------------------------------------------------------------------
-- El RPC valida con SELECT-luego-INSERT (no atómico): dos llamadas simultáneas
-- pueden pasar ambas los chequeos y colar dos reservas. Se cierra con:
--
-- 1. EXCLUDE gist: a nivel de tabla, dos reservas VIVAS del mismo recurso NO
--    pueden solaparse en el tiempo (cubre incluso duraciones distintas, que el
--    índice único por slot_inicio no atrapaba). Es la red dura.
-- 2. FOR UPDATE sobre la fila del usuario al entrar al RPC: serializa las
--    reservas concurrentes del MISMO miembro, así el tope diario y "horas
--    continuas" cuentan bien aunque mande dos submits a la vez.
-- 3. El INSERT se envuelve en un bloque que traduce la violación del constraint
--    a EKKO_SLOT_OCUPADO (mensaje amigable), por si dos carreras pasan el SELECT.
--
-- Idempotente. Requiere btree_gist (equality de uuid en gist).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_no_overlap;
ALTER TABLE reservas ADD CONSTRAINT reservas_no_overlap
  EXCLUDE USING gist (
    recurso_id WITH =,
    tstzrange(slot_inicio, slot_fin) WITH &&
  ) WHERE (status IN ('confirmada', 'completada'));


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

  IF v_usuario.membresia_tier IS NULL OR
     NOT (v_usuario.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: Tu plan no tiene acceso a este estudio';
  END IF;

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
