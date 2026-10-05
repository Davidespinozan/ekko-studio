-- ============================================================================
-- Material pendiente: señal explícita + pendiente operativo + acceso directo
-- ============================================================================
-- El dueño señaló que "subir material" vive enterrado en el perfil del miembro
-- y que no toda sesión necesita material del estudio (algunos miembros graban
-- con equipo propio). Dos piezas:
--
--  1. `reservas.material_requerido` (default TRUE: el modelo de EKKO es que el
--     estudio entrega el material — EKKO-075 — así que la excepción es "NO", no
--     al revés). Recepción la apaga en el check-in si el cliente avisa que trae
--     su propio equipo (es el único momento cara a cara); se puede corregir
--     después desde el perfil del miembro si se entera más tarde.
--  2. `staff_listar_material_pendiente()`: sesiones que SÍ requieren material,
--     ya pasaron, no están canceladas/no-show, y no tienen fila vigente en
--     `material_sesion`. La usan el centro de pendientes del dashboard (conteo)
--     y el filtro `?filtro=material_pendiente` de Miembros (mismo patrón de
--     EKKO-079: el pendiente lleva a una lista YA FILTRADA, no a una pantalla
--     nueva).
--
-- Aditiva: no reescribe ninguna fila existente (DEFAULT true no es backfill
-- inventado, es el comportamiento normal del negocio).
-- Tests: src/__tests__/db/material-pendiente.db.test.ts
-- ============================================================================

ALTER TABLE reservas ADD COLUMN IF NOT EXISTS material_requerido boolean NOT NULL DEFAULT true;

-- ── RPC: staff marca/corrige si la sesión requiere material del estudio ─────
CREATE OR REPLACE FUNCTION staff_marcar_material_requerido(p_reserva_id uuid, p_requerido boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_reserva reservas;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede marcar esto';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id AND tenant_id = v_tenant;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada en este estudio';
  END IF;

  UPDATE reservas SET material_requerido = p_requerido WHERE id = v_reserva.id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'material_requerido_cambiado', 'usuario', v_reserva.usuario_id,
          jsonb_build_object('material_requerido', v_reserva.material_requerido),
          jsonb_build_object('material_requerido', p_requerido),
          jsonb_build_object('reserva_id', v_reserva.id, 'folio', v_reserva.folio));

  RETURN jsonb_build_object('success', true, 'material_requerido', p_requerido);
END;
$$;
REVOKE ALL ON FUNCTION staff_marcar_material_requerido(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_marcar_material_requerido(uuid, boolean) TO authenticated;

-- ── RPC: lista de sesiones con material pendiente (staff, de su tenant) ─────
-- SECURITY INVOKER a propósito: solo necesita lo que `reservas_read_admin` y
-- `material_read_staff` ya permiten leer; no escala privilegios para un reporte.
CREATE OR REPLACE FUNCTION staff_listar_material_pendiente()
RETURNS TABLE (
  reserva_id uuid,
  usuario_id uuid,
  folio text,
  slot_inicio timestamptz,
  slot_fin timestamptz,
  recurso_nombre text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT r.id, r.usuario_id, r.folio, r.slot_inicio, r.slot_fin, rec.nombre
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = get_my_tenant_id()
    AND is_recepcionista()
    AND r.material_requerido
    AND r.status IN ('confirmada', 'completada')
    AND r.slot_fin < now()
    AND NOT EXISTS (
      SELECT 1 FROM material_sesion m
      WHERE m.reserva_id = r.id AND m.eliminado_at IS NULL
    )
  ORDER BY r.slot_fin ASC;
$$;
REVOKE ALL ON FUNCTION staff_listar_material_pendiente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_listar_material_pendiente() TO authenticated;
