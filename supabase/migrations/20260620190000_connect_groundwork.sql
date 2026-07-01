-- ============================================================================
-- Stripe Connect — fundación (STRYV plataforma, el estudio cobra directo)
-- ============================================================================
-- Modelo: STRYV es la plataforma; cada estudio (tenant) es una cuenta CONECTADA
-- Express que cobra directo a sus miembros (direct charges). La plataforma nunca
-- toca los fondos. `tenants.stripe_account_id` (ya existe) guarda el 'acct_...'.
-- Acá se agregan los flags de estado del onboarding, que refresca el backend
-- (connect-status / webhook de Connect) desde Stripe (fuente autoritativa).
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.stripe_charges_enabled IS
  'La cuenta conectada puede COBRAR (onboarding de Stripe completo). Gate de pagos.';
COMMENT ON COLUMN tenants.stripe_details_submitted IS
  'El dueño terminó el formulario de onboarding hospedado por Stripe.';
