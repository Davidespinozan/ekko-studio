-- ============================================================================
-- Consistencia: al QUITAR el plan de un miembro, cerrar su membresía.
-- ----------------------------------------------------------------------------
-- Antes, poner membresia_tier = NULL desde admin/recepción dejaba la fila de
-- `membresias` en 'activa' (con su fecha de renovación vieja). El perfil llegaba
-- a mostrar "Sin plan" pero con datos de una suscripción activa.
--
-- Solución en la BD (una sola fuente de verdad, funcione desde admin, recepción
-- o backend): un trigger AFTER UPDATE en `usuarios`. Cuando membresia_tier pasa
-- de un valor a NULL, se cancela la membresía vigente del usuario.
--
-- SECURITY DEFINER: corre con privilegios del owner, así también aplica cuando
-- lo dispara recepción (que por RLS no puede UPDATE directo de membresias).
-- No interfiere con activar_membresia (esa setea un slug NO nulo).
-- Idempotente y reversible (solo borra el trigger/función).
-- ============================================================================

CREATE OR REPLACE FUNCTION cancelar_membresia_al_quitar_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Cierra cualquier membresía "viva" del usuario. Preserva historial (soft).
  UPDATE membresias
  SET status = 'cancelada',
      cancelada_at = COALESCE(cancelada_at, now()),
      cancelada_efectiva_at = COALESCE(cancelada_efectiva_at, now())
  WHERE usuario_id = NEW.id
    AND status IN ('pendiente', 'trialing', 'activa', 'past_due');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cancelar_membresia_al_quitar_plan_trg ON usuarios;
CREATE TRIGGER cancelar_membresia_al_quitar_plan_trg
  AFTER UPDATE OF membresia_tier ON usuarios
  FOR EACH ROW
  WHEN (NEW.membresia_tier IS NULL AND OLD.membresia_tier IS NOT NULL)
  EXECUTE FUNCTION cancelar_membresia_al_quitar_plan();
