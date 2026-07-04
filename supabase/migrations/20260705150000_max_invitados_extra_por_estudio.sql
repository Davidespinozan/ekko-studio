-- ============================================================================
-- Máximo de invitados EXTRA por estudio (configurable por admin)
-- ----------------------------------------------------------------------------
-- Cada estudio define cuántos invitados extra (arriba del tope del plan) se
-- pueden pagar en la app para una reserva suya. 0 = ese estudio no admite
-- extras. Default 4 para que el feature funcione tras configurar el precio; el
-- admin lo ajusta por estudio en Admin → Estudios.
-- ============================================================================

ALTER TABLE recursos
  ADD COLUMN IF NOT EXISTS max_invitados_extra integer NOT NULL DEFAULT 4;

ALTER TABLE recursos
  DROP CONSTRAINT IF EXISTS recursos_max_invitados_extra_check;
ALTER TABLE recursos
  ADD CONSTRAINT recursos_max_invitados_extra_check CHECK (max_invitados_extra >= 0);

COMMENT ON COLUMN recursos.max_invitados_extra IS
  'Máx. invitados extra (de pago) permitidos por reserva de este estudio. 0 = no admite extras.';
