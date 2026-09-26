-- ============================================================================
-- Disponibilidad real para el miembro + "un solo set a la vez"
-- ============================================================================
-- A) BUG: el miembro no veía los horarios ocupados por OTROS. La grilla de
--    Reservar leía `reservas` directo, y la policy `reservas_read_self` solo le
--    deja ver las SUYAS (correcto: no debe saber quién reservó qué). Resultado: un
--    horario tomado por otra persona se pintaba LIBRE, y el miembro se enteraba al
--    confirmar ("este horario acaba de ser tomado"). Verificado ejecutando: A
--    reserva, B consulta el estudio y ve 0 reservas.
--    Fix: `slots_ocupados()` — SECURITY DEFINER, devuelve SOLO intervalos (ni
--    quién, ni folio), acotados al tenant del que pregunta.
--
-- B) PEDIDO DEL CLIENTE (solicitud de cambios, punto 3): cuando se reserva
--    cualquier set, los demás quedan bloqueados ese mismo horario — EKKO no quiere
--    dos grabaciones simultáneas por la interferencia de sonido entre sets.
--    `config.reserva.sets_exclusivos` (Admin → Reglas). Se hace cumplir en la
--    BASE, no solo en la pantalla:
--      · trigger sobre `reservas`: una reserva activa no puede traslaparse con
--        otra activa del mismo estudio (tenant), sea del set que sea;
--      · `pg_advisory_xact_lock` por tenant: dos personas reservando a la vez dos
--        sets distintos se serializan, y la segunda ya ve a la primera.
--    Cubre las dos RPC de reserva y cualquier UPDATE que reviva una reserva.
--
-- Tests conductuales: src/__tests__/db/disponibilidad.db.test.ts
-- ============================================================================

-- ── A. Qué horarios están ocupados para ESTE set ────────────────────────────
CREATE OR REPLACE FUNCTION slots_ocupados(
  p_recurso_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz
)
RETURNS TABLE (slot_inicio timestamptz, slot_fin timestamptz, mismo_set boolean)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
  v_exclusivos boolean;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  -- El set tiene que ser del estudio de quien pregunta.
  IF NOT EXISTS (SELECT 1 FROM recursos r WHERE r.id = p_recurso_id AND r.tenant_id = v_tenant) THEN
    RETURN;
  END IF;
  -- Tope del rango: es para pintar una grilla, no para exportar la agenda.
  IF p_hasta - p_desde > interval '62 days' THEN
    RAISE EXCEPTION 'EKKO_RANGO_INVALIDO: Rango demasiado amplio';
  END IF;

  SELECT COALESCE((t.config->'reserva'->>'sets_exclusivos')::boolean, false)
    INTO v_exclusivos FROM tenants t WHERE t.id = v_tenant;

  RETURN QUERY
  SELECT r.slot_inicio, r.slot_fin, (r.recurso_id = p_recurso_id) AS mismo_set
  FROM reservas r
  WHERE r.tenant_id = v_tenant
    AND r.status IN ('confirmada', 'completada')
    AND r.slot_inicio < p_hasta
    AND r.slot_fin > p_desde
    AND (r.recurso_id = p_recurso_id OR COALESCE(v_exclusivos, false))
  ORDER BY r.slot_inicio;
END;
$$;

REVOKE ALL ON FUNCTION slots_ocupados(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION slots_ocupados(uuid, timestamptz, timestamptz) TO authenticated;

COMMENT ON FUNCTION slots_ocupados(uuid, timestamptz, timestamptz) IS
  'Intervalos ocupados que bloquean un set en un rango (solo horas: sin usuario ni folio). Con reserva.sets_exclusivos incluye los de cualquier otro set del estudio.';

-- ── B. Un solo set a la vez ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reservas_un_set_a_la_vez()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exclusivos boolean;
  v_otro text;
BEGIN
  IF NEW.status NOT IN ('confirmada', 'completada') THEN
    RETURN NEW;
  END IF;
  -- En un UPDATE solo importa si la reserva ENTRA en juego o cambia de horario.
  IF TG_OP = 'UPDATE'
     AND OLD.status IN ('confirmada', 'completada')
     AND NEW.slot_inicio = OLD.slot_inicio
     AND NEW.slot_fin = OLD.slot_fin THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE((t.config->'reserva'->>'sets_exclusivos')::boolean, false)
    INTO v_exclusivos FROM tenants t WHERE t.id = NEW.tenant_id;
  IF NOT COALESCE(v_exclusivos, false) THEN
    RETURN NEW;
  END IF;

  -- Serializa las reservas simultáneas del MISMO estudio: sin esto, dos personas
  -- reservando a la vez dos sets distintos pasarían ambas la comprobación (el
  -- índice único solo protege un mismo set). Se libera al terminar la transacción.
  PERFORM pg_advisory_xact_lock(hashtextextended('ekko:sets:' || NEW.tenant_id::text, 0));

  SELECT rc.nombre INTO v_otro
  FROM reservas r
  JOIN recursos rc ON rc.id = r.recurso_id
  WHERE r.tenant_id = NEW.tenant_id
    AND r.id <> NEW.id
    AND r.recurso_id <> NEW.recurso_id
    AND r.status IN ('confirmada', 'completada')
    AND r.slot_inicio < NEW.slot_fin
    AND r.slot_fin > NEW.slot_inicio
  LIMIT 1;

  IF v_otro IS NOT NULL THEN
    RAISE EXCEPTION 'EKKO_ESTUDIO_EN_USO: Ya hay una grabación en otro set a esa hora (el estudio graba un set a la vez)';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION reservas_un_set_a_la_vez() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_un_set_a_la_vez ON reservas;
CREATE TRIGGER trg_un_set_a_la_vez
  BEFORE INSERT OR UPDATE OF status, slot_inicio, slot_fin, recurso_id ON reservas
  FOR EACH ROW EXECUTE FUNCTION reservas_un_set_a_la_vez();

-- EKKO Studio lo pidió explícitamente: queda encendido para su estudio. Otros
-- tenants lo prenden desde Admin → Reglas. No toca reservas ya existentes: si hoy
-- hubiera dos sets traslapados, siguen; la regla rige para lo que se reserve desde ya.
UPDATE tenants
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{reserva}',
  COALESCE(config->'reserva', '{}'::jsonb) || '{"sets_exclusivos": true}'::jsonb
)
WHERE slug = 'ekko'
  AND (config->'reserva'->>'sets_exclusivos') IS NULL;
