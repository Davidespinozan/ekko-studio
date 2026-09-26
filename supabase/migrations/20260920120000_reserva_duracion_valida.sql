-- ============================================================================
-- La duración de la reserva la fija el estudio, no el cliente
-- ============================================================================
-- Bug (SALA_PARITY_AUDIT_2 · S1): `p_duracion_min` llega del cliente y las RPC
-- solo lo usan para calcular `slot_fin`. El costo en créditos es fijo por
-- reserva y el tope diario cuenta reservas, así que un miembro que llamara la
-- RPC con `p_duracion_min: 720` bloqueaba un estudio todo el día por 1 crédito.
-- El chequeo de horario compara solo `::time`, así que cruzar la medianoche
-- también pasaba (21:00 + 600 min → fin 07:00).
--
-- Fix en un trigger BEFORE INSERT (cubre las dos RPC sin recrearlas):
--   · Miembro → la duración DEBE ser `config.reserva.duracion_default_min`
--     (lo único que manda la app: Reservar.tsx:147).
--   · Staff / procesos sin sesión → entre 15 min y 8 h (recepción reprograma
--     conservando la duración original aunque el default haya cambiado).
--   · Nadie → una reserva no cruza la medianoche del estudio.
-- ============================================================================

CREATE OR REPLACE FUNCTION reservas_duracion_valida()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text;
  v_default integer;
  v_tz constant text := 'America/Mazatlan';
BEGIN
  IF NEW.duracion_min IS NULL OR NEW.duracion_min <= 0 THEN
    RAISE EXCEPTION 'EKKO_DURACION_INVALIDA: La duración de la reserva no es válida';
  END IF;

  IF NEW.slot_fin IS DISTINCT FROM NEW.slot_inicio + (NEW.duracion_min || ' minutes')::interval THEN
    RAISE EXCEPTION 'EKKO_DURACION_INVALIDA: La duración no coincide con el horario de la reserva';
  END IF;

  v_rol := get_my_rol();
  IF v_rol IS NULL OR v_rol IN ('admin', 'recepcionista') THEN
    IF NEW.duracion_min < 15 OR NEW.duracion_min > 480 THEN
      RAISE EXCEPTION 'EKKO_DURACION_INVALIDA: La duración debe estar entre 15 minutos y 8 horas';
    END IF;
  ELSE
    SELECT COALESCE((config->'reserva'->>'duracion_default_min')::integer, 60)
      INTO v_default FROM tenants WHERE id = NEW.tenant_id;
    IF NEW.duracion_min <> COALESCE(v_default, 60) THEN
      RAISE EXCEPTION 'EKKO_DURACION_INVALIDA: Las sesiones de este estudio duran % minutos', COALESCE(v_default, 60);
    END IF;
  END IF;

  -- Termina el mismo día del estudio en que empieza (00:00 exacto del día
  -- siguiente se acepta: es el cierre de un slot 23:00–24:00).
  IF (NEW.slot_fin AT TIME ZONE v_tz) > date_trunc('day', NEW.slot_inicio AT TIME ZONE v_tz) + interval '1 day' THEN
    RAISE EXCEPTION 'EKKO_DURACION_INVALIDA: Una reserva no puede pasar de la medianoche';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION reservas_duracion_valida() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_duracion_valida ON reservas;
CREATE TRIGGER trg_duracion_valida
  BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION reservas_duracion_valida();
