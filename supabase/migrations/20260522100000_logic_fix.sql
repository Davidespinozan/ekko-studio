-- ============================================================================
-- LOGIC-FIX — cierre de bloqueantes de LOGIC_AUDIT.md pre-launch
-- ============================================================================
-- Cierra los hallazgos de lógica de negocio bloqueantes:
--   L-01 — la validación de horario del estudio dependía de la timezone de la
--          sesión Postgres → con sesión UTC, los slots de la tarde-noche de
--          Culiacán se rechazaban. Se ancla a 'America/Mazatlan'.
--   L-02 — check_in_atomic / check_in_manual_atomic aceptaban reservas
--          'cancelada_admin' (estado de RP-1, posterior a estas funciones) →
--          una reserva cancelada por el estudio podía pasar a 'completada'.
--   L-03 — 'revocado' no estaba en el CHECK de usuarios.status, pero
--          revokeTeamMember() lo escribe.
--
-- L-15 (invalidar el QR al cancelar) NO se incluye: `qr_token_hash` resultó ser
-- una columna muerta (nunca se escribe ni se lee — `qr-verify` valida el JWT
-- por firma). Nulearla no haría nada. El riesgo real (QR viejo tras cancelar)
-- lo cierra L-02. Ver LOGIC_AUDIT.md.
--
-- Todo idempotente. CREATE OR REPLACE de 3 funciones core + 1 CHECK.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- L-03 — `revocado` en el CHECK de usuarios.status
-- ----------------------------------------------------------------------------
-- `crudHelpers.revokeTeamMember()` escribe status='revocado' y
-- `admin-delete-user` filtra `.neq('status','revocado')`, pero el CHECK no lo
-- admitía. Idempotente: si la BD tiene drift (CHECK editado a mano) esto lo
-- deja versionado y explícito.
-- ----------------------------------------------------------------------------
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_status_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_status_check
  CHECK (status IN (
    'pendiente_onboarding', 'pendiente_pago', 'activo',
    'suspendido', 'cancelado', 'revocado'
  ));


-- ----------------------------------------------------------------------------
-- L-01 — `reservar_recurso_atomic`: validar horario en hora de Culiacán
-- ----------------------------------------------------------------------------
-- El bloque de horario comparaba `p_slot_inicio::time` y
-- `EXTRACT(DOW FROM p_slot_inicio)` — ambos dependen de la timezone de la
-- sesión Postgres. El frontend manda instantes UTC; los bloques
-- `recursos.horarios` están en hora local de Culiacán. Si la sesión es UTC
-- (default de Supabase), los slots de la tarde se rechazaban con
-- EKKO_FUERA_DE_HORARIO.
--
-- Fix: anclar la conversión a 'America/Mazatlan' (Culiacán, UTC-7 sin DST).
-- `tstz AT TIME ZONE 'America/Mazatlan'` da el reloj de pared en esa zona,
-- independiente de la timezone de la sesión. Es correcto sea cual sea el
-- `timezone` de la BD. Único cambio respecto del cuerpo vigente
-- (20260517000001) — el resto es idéntico.
--
-- Pre-launch, single-tenant: la zona se hardcodea. Cuando entre un 2º tenant,
-- moverla a `tenants.config`.
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- L-02 — check_in_atomic / check_in_manual_atomic: rechazar TODO estado que no
--        sea 'confirmada' (incluido 'cancelada_admin')
-- ----------------------------------------------------------------------------
-- Estas funciones validaban el estado con `IF status =` positivos enumerados.
-- 'cancelada_admin' (creado en RP-1, posterior a estas funciones) no matcheaba
-- ninguno → una reserva cancelada por el estudio caía al UPDATE y pasaba a
-- 'completada'. Fix: la rama de 'cancelada' ahora incluye 'cancelada_admin', y
-- un check negativo final cubre cualquier estado futuro. CREATE OR REPLACE del
-- cuerpo vigente (20260514150000) — único cambio: el bloque de estados.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_in_atomic(p_reserva_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  -- LOGIC-FIX L-02: estados no-checkineables. La rama de cancelada cubre
  -- 'cancelada' y 'cancelada_admin'; el check negativo final atrapa cualquier
  -- estado futuro no contemplado.
  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in (% UTC)', v_reserva.check_in_at;
  END IF;

  IF v_reserva.status IN ('cancelada', 'cancelada_admin') THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Esta reserva fue cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Esta reserva fue marcada como inasistencia';
  END IF;

  IF v_reserva.status != 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_CHECKINEABLE: La reserva no admite check-in (estado: %)', v_reserva.status;
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '15 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '30 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TEMPRANO: El check-in abre 15 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TARDE: El check-in cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'qr'
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION check_in_manual_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_rol text;
  v_reserva reservas;
  v_miembro usuarios;
  v_recurso recursos;
  v_now timestamptz := now();
  v_ventana_inicio timestamptz;
  v_ventana_fin timestamptz;
  v_check_ins_hoy integer;
  v_check_ins_semana integer;
  v_inicio_semana timestamptz;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();
  v_rol := get_my_rol();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  IF v_rol NOT IN ('admin', 'recepcionista', 'staff') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo staff puede hacer check-in';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: La reserva no existe';
  END IF;

  IF v_reserva.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esta reserva pertenece a otro tenant';
  END IF;

  -- LOGIC-FIX L-02: ver check_in_atomic.
  IF v_reserva.status = 'completada' THEN
    RAISE EXCEPTION 'EKKO_YA_CHECK_IN: Este miembro ya hizo check-in';
  END IF;

  IF v_reserva.status IN ('cancelada', 'cancelada_admin') THEN
    RAISE EXCEPTION 'EKKO_RESERVA_CANCELADA: Reserva cancelada';
  END IF;

  IF v_reserva.status = 'no_show' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_SHOW: Reserva marcada como inasistencia';
  END IF;

  IF v_reserva.status != 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_CHECKINEABLE: La reserva no admite check-in (estado: %)', v_reserva.status;
  END IF;

  v_ventana_inicio := v_reserva.slot_inicio - interval '30 minutes';
  v_ventana_fin := v_reserva.slot_fin + interval '60 minutes';

  IF v_now < v_ventana_inicio THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TEMPRANO: El check-in manual abre 30 min antes (a las %)',
      to_char(v_ventana_inicio, 'HH24:MI');
  END IF;

  IF v_now > v_ventana_fin THEN
    RAISE EXCEPTION 'EKKO_DEMASIADO_TARDE: El check-in manual cerró a las %',
      to_char(v_ventana_fin, 'HH24:MI');
  END IF;

  UPDATE reservas
  SET status = 'completada',
      check_in_at = v_now,
      check_in_by = v_user_id,
      check_in_method = 'manual',
      notas = COALESCE(notas, '') ||
              CASE WHEN p_motivo IS NOT NULL
                   THEN E'\n[Check-in manual: ' || p_motivo || ']'
                   ELSE E'\n[Check-in manual]'
              END
  WHERE id = p_reserva_id
  RETURNING * INTO v_reserva;

  SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id;
  SELECT * INTO v_recurso FROM recursos WHERE id = v_reserva.recurso_id;

  v_inicio_semana := date_trunc('week', v_now);

  SELECT count(*) INTO v_check_ins_hoy
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= date_trunc('day', v_now);

  SELECT count(*) INTO v_check_ins_semana
  FROM reservas
  WHERE usuario_id = v_reserva.usuario_id
    AND status = 'completada'
    AND check_in_at >= v_inicio_semana;

  RETURN jsonb_build_object(
    'success', true,
    'reserva', row_to_json(v_reserva),
    'miembro', jsonb_build_object(
      'id', v_miembro.id,
      'nombre', v_miembro.nombre,
      'email', v_miembro.email,
      'telefono', v_miembro.telefono,
      'avatar_url', v_miembro.avatar_url,
      'membresia_tier', v_miembro.membresia_tier,
      'notas_admin', v_miembro.notas_admin
    ),
    'recurso', jsonb_build_object(
      'id', v_recurso.id,
      'nombre', v_recurso.nombre
    ),
    'stats', jsonb_build_object(
      'check_ins_hoy', v_check_ins_hoy,
      'check_ins_semana', v_check_ins_semana
    )
  );
END;
$$;
