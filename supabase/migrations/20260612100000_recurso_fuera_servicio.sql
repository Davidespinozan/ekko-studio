-- ============================================================================
-- Bloque F — Recurso fuera de servicio (temporal)
-- ============================================================================
-- "Fuera de servicio" = el estudio SIGUE visible y NO se archiva (activo=true),
-- pero no se puede reservar por un rato (mantenimiento, etc.). Distinto de
-- `activo=false` (archivar = permanente, lo saca del landing/catálogo).
--
-- Enforcement: un trigger BEFORE INSERT en `reservas` rechaza cualquier alta
-- en un recurso marcado fuera de servicio. Se hace por trigger (y NO
-- reescribiendo `reservar_recurso_atomic` / `reservar_para_miembro_atomic`)
-- para no tocar el cuerpo de esos RPCs (ruta crítica) y cubrir todo path de
-- inserción con una sola pieza. El auto-cancelado de reservas existentes lo
-- hace la Netlify Function `reception-recurso-servicio` (UPDATE, no INSERT, así
-- que el trigger no lo estorba).
-- ============================================================================

ALTER TABLE recursos
  ADD COLUMN IF NOT EXISTS fuera_de_servicio boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fuera_de_servicio_motivo text;

COMMENT ON COLUMN recursos.fuera_de_servicio IS
  'Bloque F: estudio temporalmente no reservable (mantenimiento). El recurso
   sigue activo/visible; solo se bloquean reservas nuevas. Distinto de activo=false.';

-- Trigger de bloqueo: ninguna reserva nueva en un recurso fuera de servicio.
CREATE OR REPLACE FUNCTION reservas_bloquear_recurso_fuera_servicio()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM recursos
    WHERE id = NEW.recurso_id AND fuera_de_servicio = true
  ) THEN
    RAISE EXCEPTION 'EKKO_RECURSO_FUERA_SERVICIO: Este estudio está temporalmente fuera de servicio';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reservas_recurso_fuera_servicio ON reservas;
CREATE TRIGGER trg_reservas_recurso_fuera_servicio
  BEFORE INSERT ON reservas
  FOR EACH ROW
  EXECUTE FUNCTION reservas_bloquear_recurso_fuera_servicio();
