-- ============================================================================
-- "Revocar acceso" revoca de verdad: el staff inactivo pierde sus poderes en RLS
-- ============================================================================
-- Bug (SALA_PARITY_AUDIT_2 · P0-4; H2 del SECURITY_AUDIT quedó "verificado", no
-- corregido): revocar a un admin/recepcionista solo escribe
-- `usuarios.status='revocado'`. `is_admin()`, `is_recepcionista()` y
-- `get_my_rol()` miraban solo `rol`, así que con su JWT vivo (o volviendo a
-- iniciar sesión) el revocado seguía leyendo la PII de todos los miembros y
-- ejecutando las RPC de staff (check-in, reservar para terceros, pausar…).
--
-- Fix (como SALA 20260613002500): los tres helpers exigen `status='activo'`
-- para los roles de staff.
--
-- `get_my_rol()` devuelve 'revocado' —NO NULL— para staff inactivo, a propósito:
--   · `IF v_rol NOT IN ('admin','recepcionista') THEN RAISE` con NULL evalúa a
--     NULL y NO dispara → un NULL dejaría pasar al revocado.
--   · los triggers de reservas tratan `v_rol IS NULL` como "proceso sin sesión"
--     (service_role) y le quitan los topes.
-- Un miembro conserva su rol tal cual: su acceso ya se gatea por `status` en
-- cada RPC (EKKO_USUARIO_INACTIVO) y en la app.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_my_rol()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT CASE
    WHEN rol IN ('admin', 'recepcionista') AND status <> 'activo' THEN 'revocado'
    ELSE rol
  END
  FROM usuarios
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol = 'admin'
      AND status = 'activo'
  );
$$;

CREATE OR REPLACE FUNCTION is_recepcionista()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios
    WHERE auth_id = auth.uid()
      AND rol IN ('recepcionista', 'admin')
      AND status = 'activo'
  );
$$;

COMMENT ON FUNCTION get_my_rol() IS
  'Rol del usuario del JWT. Staff (admin/recepcionista) con status<>activo → ''revocado'' (nunca NULL: ver migración).';
COMMENT ON FUNCTION is_admin() IS
  'TRUE si el usuario del JWT es admin ACTIVO. status<>activo (revocado/suspendido) → FALSE.';
COMMENT ON FUNCTION is_recepcionista() IS
  'TRUE si el usuario del JWT es recepción o admin ACTIVO. status<>activo → FALSE.';

-- ── Red de seguridad al aplicar ─────────────────────────────────────────────
-- 1. Staff con un status "pendiente_*" es un accidente (un miembro ascendido por
--    admin-update-role conserva su status de miembro), no una revocación: se
--    normaliza a 'activo' para que esta migración no le quite el panel a nadie
--    que hoy lo usa legítimamente. revocado/suspendido/cancelado NO se tocan.
UPDATE usuarios
SET status = 'activo'
WHERE rol IN ('admin', 'recepcionista')
  AND status IN ('pendiente_onboarding', 'pendiente_pago');

-- 2. Si aun así un tenant con admins se quedara sin NINGÚN admin activo, abortar:
--    es preferible no aplicar que dejar al estudio fuera de su propio panel.
DO $$
DECLARE
  v_slug text;
BEGIN
  SELECT t.slug INTO v_slug
  FROM tenants t
  WHERE EXISTS (SELECT 1 FROM usuarios u WHERE u.tenant_id = t.id AND u.rol = 'admin')
    AND NOT EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.tenant_id = t.id AND u.rol = 'admin' AND u.status = 'activo'
    )
  LIMIT 1;

  IF v_slug IS NOT NULL THEN
    RAISE EXCEPTION
      'El tenant "%" no tiene ningún admin con status=activo. Activa uno (UPDATE usuarios SET status=''activo'' …) antes de aplicar esta migración.', v_slug;
  END IF;
END $$;
