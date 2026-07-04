-- ============================================================================
-- Seguridad: el rol anónimo NO debe leer columnas sensibles de tenants
-- ----------------------------------------------------------------------------
-- La policy `tenants_read_public_by_slug` (anon, status='activo') es row-level:
-- deja al público leer la FILA completa, incluyendo stripe_account_id,
-- stripe_subscription_product_id y los flags de Stripe. Son identificadores de
-- infraestructura de cobro que no tienen por qué ser públicos.
--
-- Fix: privilegios a NIVEL DE COLUMNA. Se revoca el SELECT amplio de anon y se
-- re-otorga solo sobre las columnas públicas que el sitio necesita (branding,
-- config del landing, nombre, slug). La RLS de fila sigue igual. Los usuarios
-- autenticados y service_role conservan su acceso (no se tocan sus grants).
--
-- El front ya se ajustó: TenantProvider hace select de columnas explícitas
-- (no 'select *'), así que anon no pide las columnas restringidas.
--
-- Idempotente.
-- ============================================================================

REVOKE SELECT ON tenants FROM anon;

GRANT SELECT (id, slug, nombre, config, branding, status, created_at, updated_at)
  ON tenants TO anon;
