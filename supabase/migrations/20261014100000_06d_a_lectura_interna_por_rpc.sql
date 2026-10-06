-- ============================================================================
-- PKG-06D (A) · Lectura de columnas internas por RPC de staff + búsqueda con
-- parámetros ligados (EKKO-143)
-- ============================================================================
-- Todos los usuarios de la app comparten el rol de base `authenticated`: la RLS
-- decide QUÉ FILAS ve cada quien, pero no qué columnas. Un miembro leía su propia
-- fila con `select('*')` y recibía `notas_admin`, `sancion_motivo` y los
-- marcadores de 06A; y sus reservas con `observaciones` del staff. Los grants por
-- columna (migración B de este paquete) cierran eso para `authenticated` entero,
-- así que lo interno que el STAFF sí necesita se lee aquí, por RPC con guardia:
--
--  · staff_datos_internos_cuenta(usuario)  → notas_admin, sancion_motivo, sancionado_at
--  · staff_observaciones_reserva(reserva)  → observaciones
--  · buscar_cuentas_staff(texto, rol, status) → lista de cuentas del estudio para
--    el panel, con el texto como PARÁMETRO LIGADO (antes el panel interpolaba el
--    texto en la gramática `.or()` de PostgREST: FR-27). Solo columnas seguras.
--
-- Esta migración es ADITIVA y compatible con el cliente desplegado: se activa
-- ANTES del deploy. La B (revocación de columnas) se activa DESPUÉS del deploy,
-- cuando ningún cliente publicado usa `select('*')` sobre usuarios/reservas.
-- ============================================================================

CREATE OR REPLACE FUNCTION staff_datos_internos_cuenta(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_u usuarios;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden ver los datos internos de una cuenta';
  END IF;
  SELECT * INTO v_u FROM usuarios WHERE id = p_usuario_id AND tenant_id = get_my_tenant_id();
  IF v_u.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Cuenta no encontrada o de otro estudio';
  END IF;
  RETURN jsonb_build_object('usuario_id', v_u.id, 'notas_admin', v_u.notas_admin,
                            'sancion_motivo', v_u.sancion_motivo, 'sancionado_at', v_u.sancionado_at);
END;
$$;
REVOKE ALL ON FUNCTION staff_datos_internos_cuenta(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_datos_internos_cuenta(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION staff_observaciones_reserva(p_reserva_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_obs text;
  v_ok boolean;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden ver las observaciones de una reserva';
  END IF;
  SELECT observaciones, true INTO v_obs, v_ok FROM reservas WHERE id = p_reserva_id AND tenant_id = get_my_tenant_id();
  IF v_ok IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada o de otro estudio';
  END IF;
  RETURN v_obs;
END;
$$;
REVOKE ALL ON FUNCTION staff_observaciones_reserva(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_observaciones_reserva(uuid) TO authenticated, service_role;

-- Búsqueda del panel. El texto es un parámetro: nunca forma parte de la gramática
-- del filtro. `%`, `_` y `\` del usuario se escapan para que sean texto literal.
-- p_rol = 'staff' agrupa recepcionista/admin (y el valor legado 'staff').
CREATE OR REPLACE FUNCTION buscar_cuentas_staff(p_texto text DEFAULT NULL, p_rol text DEFAULT NULL, p_status text DEFAULT NULL)
RETURNS TABLE (
  id uuid, auth_id uuid, tenant_id uuid, email text, nombre text, telefono text, avatar_url text,
  rol text, status text, membresia_tier text, membresia_activa_id uuid,
  trial_ends_at timestamptz, commitment_ends_at timestamptz, no_shows_count integer, bloqueado_hasta timestamptz,
  created_at timestamptz, updated_at timestamptz, invitado boolean,
  identidad_completa boolean, contrato_firmado boolean, contrato_firmado_at timestamptz, sancionado_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patron text;
BEGIN
  IF NOT is_recepcionista() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden buscar cuentas';
  END IF;
  IF NULLIF(trim(COALESCE(p_texto, '')), '') IS NOT NULL THEN
    v_patron := '%' || regexp_replace(trim(p_texto), '([\\%_])', '\\\1', 'g') || '%';
  END IF;
  RETURN QUERY
  SELECT u.id, u.auth_id, u.tenant_id, u.email, u.nombre, u.telefono, u.avatar_url,
         u.rol, u.status, u.membresia_tier, u.membresia_activa_id,
         u.trial_ends_at, u.commitment_ends_at, u.no_shows_count, u.bloqueado_hasta,
         u.created_at, u.updated_at, u.invitado,
         u.identidad_completa, u.contrato_firmado, u.contrato_firmado_at, u.sancionado_at
  FROM usuarios u
  WHERE u.tenant_id = get_my_tenant_id()
    AND (p_status IS NULL OR u.status = p_status)
    AND (p_rol IS NULL
         OR (p_rol = 'staff' AND u.rol IN ('recepcionista', 'staff', 'admin'))
         OR (p_rol <> 'staff' AND u.rol = p_rol))
    AND (v_patron IS NULL
         OR u.nombre ILIKE v_patron ESCAPE '\'
         OR u.email ILIKE v_patron ESCAPE '\'
         OR u.telefono ILIKE v_patron ESCAPE '\')
  ORDER BY u.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION buscar_cuentas_staff(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION buscar_cuentas_staff(text, text, text) TO authenticated, service_role;
