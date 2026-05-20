-- ============================================================================
-- RECEPCIÓN PLUS — RP-1: backend de permisos
-- ============================================================================
-- Eleva el rol `recepcionista` con capacidades de cara al cliente, sin abrir
-- gestión del negocio. Todo es ADITIVO: ninguna policy de admin se relaja.
--
-- Decisiones (RECEPCION_PLUS_PLAN.md §7):
--   D1: recepción salta `min_anticipacion_horas` (walk-ins en mostrador).
--   D2: recepción solo reserva para miembros con status='activo'.
--   D3: cancelación por un tercero (recepción/admin) → status='cancelada_admin'
--       + cancelada_por + notificación in-app al miembro.
--
-- 1. reservar_para_miembro_atomic  (NUEVO)
-- 2. cancelar_reserva_atomic       (CREATE OR REPLACE — amplía a recepción)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. reservar_para_miembro_atomic
-- ----------------------------------------------------------------------------
-- Recepción/admin reserva un recurso PARA un miembro objetivo (p_usuario_id).
-- Espeja la validación de reservar_recurso_atomic salvo:
--   - el reservante es p_usuario_id, no el llamante;
--   - gate de rol: solo admin/recepcionista;
--   - D1: NO valida min_anticipacion_horas (walk-in).
-- `bloqueado_hasta` SÍ se sigue respetando: una penalización de no-show no se
-- pisa desde el mostrador (no estaba en D1/D2; si se quiere override, es una
-- decisión nueva).
-- ----------------------------------------------------------------------------
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
  IF v_miembro.membresia_tier IS NULL OR
     NOT (v_miembro.membresia_tier = ANY(v_recurso.tiers_permitidos)) THEN
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

GRANT EXECUTE ON FUNCTION reservar_para_miembro_atomic(
  uuid, uuid, timestamptz, integer, integer, text
) TO authenticated;


-- ----------------------------------------------------------------------------
-- 2. cancelar_reserva_atomic  (CREATE OR REPLACE)
-- ----------------------------------------------------------------------------
-- Amplía la cancelación a recepción. Versión previa: solo dueño o admin.
--   - Dueño cancela lo suyo            → status='cancelada'  (sin cambios).
--   - Recepción/admin cancela ajena    → status='cancelada_admin' + cancelada_por
--                                        + notificación in-app "por el estudio".
-- Mantiene las validaciones previas: status='confirmada', slot futuro.
-- El RPC es SECURITY DEFINER → puede insertar en `notificaciones` aunque la
-- policy de INSERT sea admin-only.
-- ----------------------------------------------------------------------------
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
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE';
  END IF;

  -- Dueño, recepción o admin. (is_recepcionista() = recepcionista OR admin.)
  IF v_reserva.usuario_id != v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: No podés cancelar esta reserva';
  END IF;

  IF v_reserva.status != 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_CANCELABLE: La reserva no está confirmada';
  END IF;

  IF v_reserva.slot_inicio < now() THEN
    RAISE EXCEPTION 'EKKO_RESERVA_PASADA: No podés cancelar una reserva que ya pasó';
  END IF;

  v_por_tercero := (v_reserva.usuario_id != v_user_id);

  IF v_por_tercero THEN
    -- D3: cancelación hecha por el estudio (recepción/admin).
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
    -- El propio miembro cancela: comportamiento original.
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

GRANT EXECUTE ON FUNCTION cancelar_reserva_atomic(uuid, text) TO authenticated;
