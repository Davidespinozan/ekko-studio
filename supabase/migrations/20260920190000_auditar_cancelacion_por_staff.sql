-- ============================================================================
-- Cuando el ESTUDIO cancela una reserva, queda en la bitácora quién fue
-- ============================================================================
-- Era la única acción de mostrador sin rastro: `cancelar_reserva_atomic` escribe
-- el motivo y avisa al miembro, pero no audita al actor — y esa cancelación
-- además DEVUELVE el crédito. El panel admin, peor: cancela con un UPDATE directo.
-- "¿Quién le canceló la sesión a Ana y por qué?" no tenía respuesta.
--
-- Un trigger (en vez de recrear la RPC) cubre los dos caminos a la vez: cualquier
-- paso de `confirmada` → `cancelada_admin`. Se audita sobre el MIEMBRO
-- (target_tipo='usuario') para que aparezca en su "Historial de cambios", que es
-- lo que recepción puede leer (policy audit_log_select_recepcion).
-- ============================================================================

CREATE OR REPLACE FUNCTION reservas_auditar_cancelacion_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (
    NEW.tenant_id,
    get_my_user_id(),                       -- NULL si fue un proceso sin sesión
    COALESCE(get_my_rol(), 'service_role'),
    'reserva_cancelada_por_estudio',
    'usuario',
    NEW.usuario_id,
    jsonb_build_object('reserva_status', OLD.status),
    jsonb_build_object('reserva_status', NEW.status),
    NULLIF(trim(COALESCE(NEW.cancelada_motivo, '')), ''),
    jsonb_build_object('reserva_id', NEW.id, 'folio', NEW.folio, 'recurso_id', NEW.recurso_id,
                       'slot_inicio', NEW.slot_inicio)
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION reservas_auditar_cancelacion_staff() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auditar_cancelacion_staff ON reservas;
CREATE TRIGGER trg_auditar_cancelacion_staff
  AFTER UPDATE OF status ON reservas
  FOR EACH ROW
  WHEN (OLD.status = 'confirmada' AND NEW.status = 'cancelada_admin')
  EXECUTE FUNCTION reservas_auditar_cancelacion_staff();
