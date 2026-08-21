-- ============================================================================
-- Oráculos escalares: los count_* solo cuentan el tenant PROPIO
-- ============================================================================
-- count_active_admins / count_admins_activos recibían un p_tenant_id arbitrario y
-- count_reservas_recurso / count_miembros_tier un id de cualquier tenant: las
-- cuatro son SECURITY DEFINER con EXECUTE para authenticated, así que cualquier
-- usuario logueado podía contar admins/reservas/miembros de otros tenants (L1 de
-- SECURITY_AUDIT.md). Regla (SALA 20260819120000): si hay contexto de usuario
-- se usa SU tenant y se ignora el parámetro; sin contexto (service_role, p. ej.
-- admin-update-role) se respeta el parámetro. Idempotente.
-- ============================================================================

CREATE OR REPLACE FUNCTION count_active_admins(p_tenant_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COUNT(*)::integer FROM usuarios
  WHERE tenant_id = COALESCE(get_my_tenant_id(), p_tenant_id)
    AND rol = 'admin'
    AND status NOT IN ('cancelado', 'suspendido');
$$;

CREATE OR REPLACE FUNCTION count_admins_activos(p_tenant_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM usuarios
  WHERE tenant_id = COALESCE(get_my_tenant_id(), p_tenant_id)
    AND rol = 'admin'
    AND status = 'activo';
$$;

CREATE OR REPLACE FUNCTION count_reservas_recurso(p_recurso_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM reservas
  WHERE recurso_id = p_recurso_id
    AND (get_my_tenant_id() IS NULL OR tenant_id = get_my_tenant_id());
$$;

CREATE OR REPLACE FUNCTION count_miembros_tier(p_tier_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(DISTINCT user_id) FROM (
    SELECT m.usuario_id AS user_id
      FROM membresias m
      JOIN tiers t ON t.id = m.tier_id
      WHERE m.tier_id = p_tier_id
        AND (get_my_tenant_id() IS NULL OR t.tenant_id = get_my_tenant_id())
    UNION
    SELECT u.id AS user_id
      FROM usuarios u
      JOIN tiers t ON t.slug = u.membresia_tier AND t.tenant_id = u.tenant_id
      WHERE t.id = p_tier_id
        AND (get_my_tenant_id() IS NULL OR t.tenant_id = get_my_tenant_id())
  ) AS combined;
$$;

-- CREATE OR REPLACE conserva los GRANT (authenticated los usa desde el front).

-- ── Self-test de contrato ────────────────────────────────────────────────────
DO $$
DECLARE
  f text;
  v_src text;
BEGIN
  FOREACH f IN ARRAY ARRAY['count_active_admins', 'count_admins_activos', 'count_reservas_recurso', 'count_miembros_tier'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = f AND pronamespace = 'public'::regnamespace;
    IF v_src IS NULL OR position('get_my_tenant_id' in v_src) = 0 THEN
      RAISE EXCEPTION '% debe acotar el conteo al tenant del caller (get_my_tenant_id)', f;
    END IF;
  END LOOP;
END $$;
