-- ============================================================================
-- SEC-FIX — cierre de vulnerabilidades CRITICAL + HIGH pre-launch
-- ============================================================================
-- Cierra los hallazgos de SECURITY_AUDIT.md que se arreglan en la base de datos:
--   C2 — un miembro se auto-eleva a rol='admin' (RLS no es column-level)
--   C3 — dev_activar_miembro (función dev SECURITY DEFINER sin gate) sigue viva
--   H1 — recepción puede leer stripe_customer_id / ob_data de cualquier miembro
--   H3 — cancelar_reserva_atomic no valida tenant (cancelación cross-tenant)
--   H5 — marcar_no_shows ejecutable por cualquier authenticated
--
-- C1 (fake-signup) y H4 (logs de password) se arreglan en las Netlify Functions.
-- H6 (QR_JWT_SECRET) es operativo (env var de Netlify). Todo idempotente.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- C2 — Bloquear la auto-elevación de columnas privilegiadas en `usuarios`
-- ----------------------------------------------------------------------------
-- La policy `usuarios_update_self` permite UPDATE de la fila propia, pero RLS
-- en Postgres es ROW-level, no COLUMN-level: el WITH CHECK no impide tocar la
-- columna `rol`. Un miembro podía hacer `UPDATE usuarios SET rol='admin'`.
--
-- Fix: trigger BEFORE UPDATE que rechaza cambios a columnas privilegiadas
-- cuando el caller es un usuario logueado normal (no admin).
--
-- IMPORTANTE — por qué SECURITY INVOKER (y no DEFINER):
--   El trigger distingue las vías legítimas mirando `current_user`:
--     - UPDATE directo de un usuario logueado vía PostgREST → 'authenticated'
--     - Netlify Functions (admin-update-role, reception-create-member, …)
--       con service_role                                    → 'service_role'
--     - RPCs SECURITY DEFINER (marcar_no_shows, check_in_*)  → dueño de la RPC
--   Con SECURITY DEFINER, `current_user` sería SIEMPRE el dueño del trigger y
--   la detección no funcionaría → rompería los flujos de admin/service_role.
--   Por eso INVOKER: `current_user` refleja el rol real del request.
--   Solo se controla el caso 'authenticated' + NOT is_admin() — el resto pasa.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION proteger_columnas_privilegiadas_usuarios()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND NOT is_admin() THEN
    IF NEW.rol             IS DISTINCT FROM OLD.rol
    OR NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
    OR NEW.status          IS DISTINCT FROM OLD.status
    OR NEW.membresia_tier  IS DISTINCT FROM OLD.membresia_tier
    OR NEW.no_shows_count  IS DISTINCT FROM OLD.no_shows_count
    OR NEW.bloqueado_hasta IS DISTINCT FROM OLD.bloqueado_hasta THEN
      RAISE EXCEPTION
        'EKKO_NO_AUTORIZADO: no podés modificar campos privilegiados de tu cuenta';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proteger_columnas_usuarios ON usuarios;
CREATE TRIGGER trg_proteger_columnas_usuarios
  BEFORE UPDATE ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION proteger_columnas_privilegiadas_usuarios();


-- ----------------------------------------------------------------------------
-- C3 — Eliminar TODAS las funciones dev_*
-- ----------------------------------------------------------------------------
-- `dev_activar_miembro` (SECURITY DEFINER, sin gate, sin filtro de tenant) se
-- escapó de SEC-CLEANUP. En vez de dropear por nombre conocido, este bloque
-- descubre y dropea CUALQUIER función `public.dev_*`, sea cual sea su firma
-- (la lección de que dev_activar_miembro se escapó). Sin CASCADE: si algo
-- dependiera de una, el DROP falla en voz alta.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_dropped integer := 0;
BEGIN
  FOR r IN
    SELECT 'DROP FUNCTION IF EXISTS public.' || quote_ident(p.proname)
           || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS stmt,
           p.proname AS nombre
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'dev\_%'
  LOOP
    EXECUTE r.stmt;
    v_dropped := v_dropped + 1;
    RAISE NOTICE 'SEC-FIX C3: dropeada función dev → %', r.nombre;
  END LOOP;

  IF v_dropped = 0 THEN
    RAISE NOTICE 'SEC-FIX C3: no quedaban funciones dev_* — nada que eliminar.';
  END IF;
END;
$$;


-- ----------------------------------------------------------------------------
-- H1 — Sacar columnas sensibles de `usuarios` a una tabla admin-only
-- ----------------------------------------------------------------------------
-- RLS no es column-level: la policy `usuarios_read_admin` (is_recepcionista())
-- deja a recepción leer TODAS las columnas, incl. `stripe_customer_id` y
-- `ob_data`. Un GRANT de columnas no sirve (admin y recepción comparten el
-- mismo rol Postgres `authenticated`). Una vista tampoco impide el acceso a la
-- tabla base. La solución robusta: mover esas columnas a una tabla aparte con
-- su propia RLS — admin del tenant + el propio dueño. Recepción no la alcanza.
--
-- Bonus: `SELECT *` sobre `usuarios` sigue funcionando (las columnas ya no
-- existen ahí) → cero cambios en el frontend.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios_datos_privados (
  usuario_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  stripe_customer_id text,
  ob_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usuarios_datos_privados_tenant_idx
  ON usuarios_datos_privados (tenant_id);
CREATE INDEX IF NOT EXISTS usuarios_datos_privados_stripe_idx
  ON usuarios_datos_privados (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE usuarios_datos_privados ENABLE ROW LEVEL SECURITY;

-- El dueño lee SUS propios datos (onboarding). Sin INSERT/UPDATE para el
-- dueño: cuando se construya el onboarding real, ese sprint decide la vía
-- de escritura (RPC acotado a `ob_data`, sin tocar `stripe_customer_id`).
DROP POLICY IF EXISTS udp_select_self ON usuarios_datos_privados;
CREATE POLICY udp_select_self ON usuarios_datos_privados
  FOR SELECT TO authenticated
  USING (usuario_id = get_my_user_id());

-- Admin del tenant: acceso completo. Recepción NO entra (no es is_admin()).
DROP POLICY IF EXISTS udp_admin_all ON usuarios_datos_privados;
CREATE POLICY udp_admin_all ON usuarios_datos_privados
  FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin())
  WITH CHECK (tenant_id = get_my_tenant_id() AND is_admin());

-- service_role (Netlify Functions, futuro webhook de Stripe) bypasa RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON usuarios_datos_privados TO authenticated;

DROP TRIGGER IF EXISTS usuarios_datos_privados_set_updated_at ON usuarios_datos_privados;
CREATE TRIGGER usuarios_datos_privados_set_updated_at
  BEFORE UPDATE ON usuarios_datos_privados
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Migrar los datos existentes (solo filas con datos reales — la tabla queda
-- esparsa). Hoy ambos campos están casi vacíos: Stripe no está integrado y el
-- onboarding aún no escribe `ob_data`.
INSERT INTO usuarios_datos_privados (usuario_id, tenant_id, stripe_customer_id, ob_data)
SELECT id, tenant_id, stripe_customer_id, ob_data
FROM usuarios
WHERE stripe_customer_id IS NOT NULL
   OR (ob_data IS NOT NULL AND ob_data <> '{}'::jsonb)
ON CONFLICT (usuario_id) DO NOTHING;

-- Quitar las columnas de `usuarios`. Sin CASCADE: si algún objeto dependiera
-- de ellas, el DROP falla en voz alta (mejor que romper en silencio).
ALTER TABLE usuarios DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE usuarios DROP COLUMN IF EXISTS ob_data;


-- ----------------------------------------------------------------------------
-- H3 — `cancelar_reserva_atomic`: validar tenant cuando cancela un tercero
-- ----------------------------------------------------------------------------
-- El RPC fue ampliado en RP-1 para que recepción/admin cancele reservas de
-- miembros. Pero no valida que la reserva sea de SU tenant → recepción/admin
-- del Tenant A podía cancelar una reserva del Tenant B conociendo el UUID.
-- `check_in_atomic` sí valida tenant; este se quedó sin esa verificación.
--
-- CREATE OR REPLACE del cuerpo completo (RP-1) + la verificación de tenant.
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

  -- SEC-FIX (H3): si la cancela un tercero (recepción/admin), la reserva
  -- debe ser de SU tenant. El dueño cancelando lo suyo es same-tenant por
  -- construcción, así que solo se verifica en el caso de tercero.
  IF v_reserva.usuario_id != v_user_id
     AND v_reserva.tenant_id IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: La reserva pertenece a otro estudio';
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


-- ----------------------------------------------------------------------------
-- H5 — `marcar_no_shows`: restringir la ejecución a service_role
-- ----------------------------------------------------------------------------
-- Estaba GRANT ... TO authenticated y sin gate de rol → cualquier miembro
-- podía `supabase.rpc('marcar_no_shows')` y forzar penalizaciones masivas.
-- Solo el cron (`cron-no-shows`, que corre con service_role) la necesita.
-- Esto cierra el vector `supabase.rpc()` directo. La exposición del endpoint
-- HTTP de la scheduled function es operativa — ver SECURITY_AUDIT.md (H5).
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;
