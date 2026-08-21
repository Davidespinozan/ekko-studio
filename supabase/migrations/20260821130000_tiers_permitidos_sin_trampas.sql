-- ============================================================================
-- Acceso por plan sin trampas: lista vacía = estudio abierto; slugs siempre reales
-- ============================================================================
-- `recursos.tiers_permitidos` es un text[] de slugs SIN llave foránea a `tiers`.
-- Dos agujeros (los mismos que SALA cerró en 20260715130000):
--
-- 1) LA LISTA VACÍA SIGNIFICABA LO CONTRARIO EN LA APP Y EN LA BASE. El front
--    (reservaLogic.puedeReservarRecurso) trata {} como "abierto"; el gate SQL
--    era `membresia_tier = ANY(tiers_permitidos)`, que contra {} es SIEMPRE
--    falso. El admin que destildaba todos los planes en Recursos dejaba el
--    estudio inalcanzable, sin ningún aviso ("Plan: —").
-- 2) ARCHIVAR UN PLAN DEJABA SU SLUG FANTASMA EN LAS LISTAS. Los seeds nacen con
--    ARRAY['basica','pro']; las migraciones 0703/0704 tuvieron que parchar a
--    mano los slugs del tenant ekko — síntoma del mismo problema.
--
-- Regla, ahora explícita y garantizada por la base:
--   · Lista VACÍA = abierto a cualquier plan.
--   · Lista CON slugs = solo esos planes; y solo pueden ser slugs de planes
--     ACTIVOS del mismo tenant (trigger en recursos).
--   · Archivar/borrar un plan lo saca de todas las listas (trigger en tiers). Si
--     un estudio se queda sin planes, queda abierto — nunca inalcanzable.
--
-- Las dos RPC de reserva se recrean con el cuerpo COPIADO PROGRAMÁTICAMENTE del
-- archivo vigente (20260704190000 y 20260520100000) cambiando SOLO el gate. Al
-- final, un test de contrato afirma que los demás guards siguen ahí.
-- ============================================================================

-- ── 0. El gate, en un solo lugar ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _recurso_permite_tier(p_permitidos text[], p_tier text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    p_permitidos IS NULL
    OR cardinality(p_permitidos) = 0
    OR (p_tier IS NOT NULL AND p_tier = ANY(p_permitidos));
$$;
REVOKE ALL ON FUNCTION _recurso_permite_tier(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _recurso_permite_tier(text[], text) TO authenticated, service_role;

-- ── 1. Limpieza: fuera los slugs que no son de un plan ACTIVO del mismo tenant ──
UPDATE recursos r
SET tiers_permitidos = COALESCE(ARRAY(
  SELECT s FROM unnest(r.tiers_permitidos) AS s
  WHERE EXISTS (SELECT 1 FROM tiers t WHERE t.tenant_id = r.tenant_id AND t.slug = s AND t.activo)
), '{}')
WHERE r.tiers_permitidos IS NULL
   OR EXISTS (
     SELECT 1 FROM unnest(r.tiers_permitidos) AS s
     WHERE NOT EXISTS (SELECT 1 FROM tiers t WHERE t.tenant_id = r.tenant_id AND t.slug = s AND t.activo)
   );

ALTER TABLE recursos ALTER COLUMN tiers_permitidos SET DEFAULT '{}';

-- ── 2. Trigger en recursos: solo slugs de planes activos del tenant ──────────
CREATE OR REPLACE FUNCTION recursos_validar_tiers_permitidos()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_malos text[];
BEGIN
  IF NEW.tiers_permitidos IS NULL THEN
    NEW.tiers_permitidos := '{}';
  END IF;
  -- Dedupe + sin vacíos.
  NEW.tiers_permitidos := ARRAY(SELECT DISTINCT s FROM unnest(NEW.tiers_permitidos) s WHERE s IS NOT NULL AND s <> '');
  SELECT ARRAY_AGG(s) INTO v_malos
  FROM unnest(NEW.tiers_permitidos) AS s
  WHERE NOT EXISTS (SELECT 1 FROM tiers t WHERE t.tenant_id = NEW.tenant_id AND t.slug = s AND t.activo);
  IF v_malos IS NOT NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_PERMITIDO_INVALIDO: Los planes % no existen o están archivados en este estudio', array_to_string(v_malos, ', ');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recursos_validar_tiers_permitidos ON recursos;
CREATE TRIGGER trg_recursos_validar_tiers_permitidos
  BEFORE INSERT OR UPDATE OF tiers_permitidos, tenant_id ON recursos
  FOR EACH ROW EXECUTE FUNCTION recursos_validar_tiers_permitidos();

-- ── 3. Trigger en tiers: archivar/borrar un plan lo saca de las listas ───────
CREATE OR REPLACE FUNCTION tiers_retirar_de_recursos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.activo AND NOT NEW.activo) THEN
    UPDATE recursos
    SET tiers_permitidos = array_remove(tiers_permitidos, OLD.slug)
    WHERE tenant_id = OLD.tenant_id AND OLD.slug = ANY(tiers_permitidos);
  END IF;
  -- Cambio de slug de un plan activo: seguir al plan.
  IF TG_OP = 'UPDATE' AND NEW.activo AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    UPDATE recursos
    SET tiers_permitidos = array_replace(tiers_permitidos, OLD.slug, NEW.slug)
    WHERE tenant_id = OLD.tenant_id AND OLD.slug = ANY(tiers_permitidos);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_tiers_retirar_de_recursos ON tiers;
CREATE TRIGGER trg_tiers_retirar_de_recursos
  AFTER UPDATE OF activo, slug OR DELETE ON tiers
  FOR EACH ROW EXECUTE FUNCTION tiers_retirar_de_recursos();

-- ── 4. reservar_recurso_atomic (socio): cuerpo literal de 20260704190000, solo el gate ──
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

  -- Gate de plan en UN solo lugar (_recurso_permite_tier): lista vacía = abierto.
  IF NOT _recurso_permite_tier(v_recurso.tiers_permitidos, v_usuario.membresia_tier) THEN
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

-- ── 5. reservar_para_miembro_atomic (recepción): cuerpo literal de 20260520100000, solo el gate ──
CREATE OR REPLACE FUNCTION reservar_para_miembro_atomic(
  p_usuario_id uuid,
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
  v_rol text;
  v_tenant_id uuid;
  v_miembro usuarios;
  v_recurso recursos;
  v_slot_fin timestamptz;
  v_now timestamptz := now();
  v_max_invitados integer;
  v_existe_continua boolean;
  v_existe_doble boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
BEGIN
  v_rol := get_my_rol();
  v_tenant_id := get_my_tenant_id();

  -- Gate de rol — solo recepción o admin (patrón de check_in_*_atomic).
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden reservar para un miembro';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Sesión inválida';
  END IF;

  -- Miembro objetivo: debe existir y ser del MISMO tenant.
  SELECT * INTO v_miembro
  FROM usuarios
  WHERE id = p_usuario_id AND tenant_id = v_tenant_id;

  IF v_miembro.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  -- D2: solo miembros activos.
  IF v_miembro.status != 'activo' THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_NO_ACTIVO: El miembro no está activo (%). Avisá a administración', v_miembro.status;
  END IF;

  -- Penalización por no-show: se respeta (no waived por D1/D2).
  IF v_miembro.bloqueado_hasta IS NOT NULL AND v_miembro.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_BLOQUEADO: El miembro tiene una restricción hasta el %',
      to_char(v_miembro.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- Recurso: existe, del tenant, activo.
  SELECT * INTO v_recurso FROM recursos WHERE id = p_recurso_id;

  IF v_recurso.id IS NULL OR v_recurso.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: Estudio no encontrado';
  END IF;

  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'EKKO_RECURSO_INACTIVO: Este estudio no está disponible';
  END IF;

  -- Tier del miembro permite el recurso.
  -- Gate de plan en UN solo lugar (_recurso_permite_tier): lista vacía = abierto.
  IF NOT _recurso_permite_tier(v_recurso.tiers_permitidos, v_miembro.membresia_tier) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: El plan del miembro no tiene acceso a este estudio';
  END IF;

  -- Invitados dentro del límite del tier.
  v_max_invitados := max_invitados_por_tier(v_miembro.membresia_tier);
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: El plan del miembro permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  -- D1: NO se valida min_anticipacion_horas — recepción reserva walk-ins.

  -- No-continuas: el MIEMBRO objetivo no puede tener slot pegado.
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE usuario_id = p_usuario_id
      AND status IN ('confirmada', 'completada')
      AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
  ) INTO v_existe_continua;

  IF v_existe_continua THEN
    RAISE EXCEPTION 'EKKO_CONTINUA: El miembro ya tiene una reserva en una hora contigua';
  END IF;

  -- Slot del recurso libre (no solape).
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE recurso_id = p_recurso_id
      AND status IN ('confirmada', 'completada')
      AND tstzrange(slot_inicio, slot_fin, '[)') && tstzrange(p_slot_inicio, v_slot_fin, '[)')
  ) INTO v_existe_doble;

  IF v_existe_doble THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END IF;

  -- Folio.
  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  INSERT INTO reservas (
    tenant_id, recurso_id, usuario_id,
    slot_inicio, slot_fin, duracion_min,
    invitados_count, status, folio, notas
  ) VALUES (
    v_tenant_id, p_recurso_id, p_usuario_id,
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

GRANT EXECUTE ON FUNCTION reservar_recurso_atomic(uuid, timestamptz, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION reservar_para_miembro_atomic(uuid, uuid, timestamptz, integer, integer, text) TO authenticated;

-- ── 6. Test de contrato: ningún guard se perdió en la copia ──────────────────
DO $$
DECLARE
  v_socio text;
  v_recep text;
  g text;
BEGIN
  SELECT prosrc INTO v_socio FROM pg_proc WHERE proname = 'reservar_recurso_atomic' AND pronamespace = 'public'::regnamespace;
  SELECT prosrc INTO v_recep FROM pg_proc WHERE proname = 'reservar_para_miembro_atomic' AND pronamespace = 'public'::regnamespace;
  FOREACH g IN ARRAY ARRAY[
    '_recurso_permite_tier', 'EKKO_TIER_NO_PERMITIDO', 'EKKO_USUARIO_INACTIVO', 'EKKO_USUARIO_BLOQUEADO',
    'EKKO_RECURSO_INACTIVO', 'EKKO_INVITADOS_EXCEDEN', 'EKKO_ANTICIPACION_INSUFICIENTE',
    'EKKO_FUERA_DE_HORARIO', 'EKKO_CONTINUA', 'EKKO_LIMITE_DIARIO', 'EKKO_SLOT_OCUPADO', 'FOR UPDATE'
  ] LOOP
    IF position(g in v_socio) = 0 THEN
      RAISE EXCEPTION 'reservar_recurso_atomic perdió el guard %', g;
    END IF;
  END LOOP;
  FOREACH g IN ARRAY ARRAY[
    '_recurso_permite_tier', 'EKKO_TIER_NO_PERMITIDO', 'EKKO_NO_AUTORIZADO', 'EKKO_MIEMBRO_INVALIDO',
    'EKKO_MIEMBRO_NO_ACTIVO', 'EKKO_MIEMBRO_BLOQUEADO', 'EKKO_RECURSO_INACTIVO', 'EKKO_INVITADOS_EXCEDEN',
    'EKKO_CONTINUA', 'EKKO_SLOT_OCUPADO'
  ] LOOP
    IF position(g in v_recep) = 0 THEN
      RAISE EXCEPTION 'reservar_para_miembro_atomic perdió el guard %', g;
    END IF;
  END LOOP;
  -- La regla misma:
  IF NOT _recurso_permite_tier('{}'::text[], NULL) OR NOT _recurso_permite_tier(NULL, 'premium')
     OR _recurso_permite_tier(ARRAY['premium'], NULL) OR _recurso_permite_tier(ARRAY['premium'], 'esencial')
     OR NOT _recurso_permite_tier(ARRAY['premium'], 'premium') THEN
    RAISE EXCEPTION '_recurso_permite_tier no cumple la regla (vacío = abierto; con lista = solo esos planes)';
  END IF;
END $$;
