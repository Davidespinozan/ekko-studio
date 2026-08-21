-- ============================================================================
-- Recepción: la RPC de reserva en mostrador al nivel de la del socio
-- ============================================================================
-- `reservar_para_miembro_atomic` (20260520100000) nunca se recreó después y
-- quedó atrás de `reservar_recurso_atomic`:
--   · no validaba `recursos.horarios` → recepción reservaba fuera del horario;
--   · prohibía SIEMPRE las horas continuas, ignorando config.reserva.permitir_continuas;
--   · sin FOR UPDATE sobre el miembro (dos submits del mostrador se colaban);
--   · no traducía `exclusion_violation` (el error crudo del constraint llegaba a la UI);
--   · el máximo de invitados salía del CASE legacy pro/basica → 0 con los planes
--     actuales (recepción no podía registrar invitados al reservar).
-- Se mantiene la decisión D1 (sin anticipación mínima: walk-ins) y el tope
-- diario sigue siendo del flujo del socio (el mostrador puede hacer excepciones).
-- El cuerpo parte del vigente (20260821130000) y se cambian solo esos puntos.
--
-- Además:
--   · Trigger `trg_anticipacion_maxima`: config.reserva.anticipacion_max_dias se
--     valida en la BASE para el miembro (la RPC lo perdió en 20260514160000 y
--     solo lo limitaba la UI: un mensual sin débito de créditos podía reservar a
--     meses vista vía RPC directo). Staff sin tope. (SALA 20260714140000.)
--   · Policy `membresias_read_staff`: recepción lee las membresías de SU tenant
--     (vigencia y créditos en la ficha y en el check-in). Solo SELECT.
-- Idempotente.
-- ============================================================================

-- ── 1. reservar_para_miembro_atomic (recepción) ─────────────────────────────
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
  v_tenant tenants;
  v_permitir_continuas boolean;
  v_dia_semana text;
  v_slot_dentro_horario boolean;
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
  -- FOR UPDATE: serializa reservas concurrentes del mismo miembro (igual que la
  -- RPC del socio) para que "continuas" y el solape cuenten bien.
  SELECT * INTO v_miembro
  FROM usuarios
  WHERE id = p_usuario_id AND tenant_id = v_tenant_id
  FOR UPDATE;
  SELECT * INTO v_tenant FROM tenants WHERE id = v_tenant_id;

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

  -- Invitados dentro del límite del plan: tiers.reglas.max_invitados (el CASE
  -- legacy pro/basica solo como fallback; con los planes actuales daba 0).
  SELECT COALESCE((t.reglas->>'max_invitados')::integer, max_invitados_por_tier(v_miembro.membresia_tier))
    INTO v_max_invitados
  FROM tiers t
  WHERE t.tenant_id = v_tenant_id AND t.slug = v_miembro.membresia_tier;
  IF v_max_invitados IS NULL THEN
    v_max_invitados := max_invitados_por_tier(v_miembro.membresia_tier);
  END IF;
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: El plan del miembro permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  -- D1: NO se valida min_anticipacion_horas — recepción reserva walk-ins.

  -- Horario del estudio (mismo chequeo que la RPC del socio, en la zona del
  -- estudio). Antes recepción podía reservar fuera del horario publicado.
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
      RAISE EXCEPTION 'EKKO_FUERA_DE_HORARIO: Este horario no está dentro del horario del estudio';
    END IF;
  END IF;

  -- No-continuas: respeta config.reserva.permitir_continuas del tenant (antes
  -- recepción SIEMPRE prohibía, aunque el estudio lo permitiera).
  v_permitir_continuas := COALESCE(
    (v_tenant.config->'reserva'->>'permitir_continuas')::boolean,
    (v_tenant.config->>'permitir_continuas')::boolean,
    false
  );
  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = p_usuario_id
        AND status IN ('confirmada', 'completada')
        AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;

    IF v_existe_continua THEN
      RAISE EXCEPTION 'EKKO_CONTINUA: El miembro ya tiene una reserva en una hora contigua';
    END IF;
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

  -- Red dura: si dos carreras pasaron el SELECT, el EXCLUDE gist rechaza el 2º
  -- INSERT → se traduce a EKKO_SLOT_OCUPADO (antes llegaba el error crudo del
  -- constraint `reservas_no_overlap` a la pantalla de recepción).
  BEGIN
    INSERT INTO reservas (
      tenant_id, recurso_id, usuario_id,
      slot_inicio, slot_fin, duracion_min,
      invitados_count, status, folio, notas
    ) VALUES (
      v_tenant_id, p_recurso_id, p_usuario_id,
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

GRANT EXECUTE ON FUNCTION reservar_para_miembro_atomic(uuid, uuid, timestamptz, integer, integer, text) TO authenticated;

-- ── 2. Anticipación máxima en la base (solo miembros) ───────────────────────
CREATE OR REPLACE FUNCTION reservas_anticipacion_maxima()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text;
  v_max_dias integer;
BEGIN
  v_rol := get_my_rol();
  -- Staff (admin/recepción) y procesos sin sesión (service_role) no tienen tope.
  IF v_rol IS NULL OR v_rol IN ('admin', 'recepcionista') THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE((config->'reserva'->>'anticipacion_max_dias')::integer, 30)
    INTO v_max_dias FROM tenants WHERE id = NEW.tenant_id;
  IF v_max_dias > 0 AND NEW.slot_inicio > now() + (v_max_dias || ' days')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_EXCESIVA: No puedes reservar con más de % días de anticipación', v_max_dias;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_anticipacion_maxima ON reservas;
CREATE TRIGGER trg_anticipacion_maxima
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION reservas_anticipacion_maxima();

-- ── 3. Recepción lee membresías de su tenant ────────────────────────────────
DROP POLICY IF EXISTS membresias_read_staff ON membresias;
CREATE POLICY membresias_read_staff ON membresias
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND get_my_rol() IN ('admin', 'recepcionista'));

-- ── 4. Test de contrato ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
  g text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'reservar_para_miembro_atomic' AND pronamespace = 'public'::regnamespace;
  FOREACH g IN ARRAY ARRAY[
    'EKKO_NO_AUTORIZADO', 'EKKO_MIEMBRO_INVALIDO', 'EKKO_MIEMBRO_NO_ACTIVO', 'EKKO_MIEMBRO_BLOQUEADO',
    'EKKO_RECURSO_INACTIVO', '_recurso_permite_tier', 'EKKO_TIER_NO_PERMITIDO', 'EKKO_INVITADOS_EXCEDEN',
    'EKKO_FUERA_DE_HORARIO', 'permitir_continuas', 'EKKO_CONTINUA', 'EKKO_SLOT_OCUPADO',
    'FOR UPDATE', 'exclusion_violation', 'max_invitados'
  ] LOOP
    IF position(g in v_src) = 0 THEN
      RAISE EXCEPTION 'reservar_para_miembro_atomic perdió el guard %', g;
    END IF;
  END LOOP;
  -- D1 se conserva: la RPC de recepción NO valida anticipación mínima.
  IF position('EKKO_ANTICIPACION_INSUFICIENTE' in v_src) > 0 THEN
    RAISE EXCEPTION 'reservar_para_miembro_atomic no debe validar anticipación mínima (D1: walk-ins)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_anticipacion_maxima') THEN
    RAISE EXCEPTION 'falta trg_anticipacion_maxima';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'membresias' AND policyname = 'membresias_read_staff') THEN
    RAISE EXCEPTION 'falta membresias_read_staff';
  END IF;
END $$;
