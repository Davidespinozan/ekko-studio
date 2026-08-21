-- ============================================================================
-- tenants: columnas de Stripe solo para el backend; UPDATE solo de lo editable
-- ============================================================================
-- 20260704180000 revocó el SELECT amplio solo a `anon`. `authenticated`
-- conservaba SELECT de TABLA → cualquier miembro/recepcionista leía
-- stripe_account_id, stripe_subscription_product_id, stripe_charges_enabled y
-- stripe_details_submitted de su tenant. Además `tenants_admin_update` (RLS de
-- fila) dejaba al admin hacer UPDATE de CUALQUIER columna, incluidos los flags
-- que gatean el cobro (stripe_charges_enabled) que solo deben escribir
-- connect-onboarding / connect-status / el webhook (service_role).
--
-- Lección de SALA (20260804140000): el REVOKE por columna no sirve mientras
-- quede el SELECT a nivel de tabla; hay que quitarlo y re-otorgar por columnas.
--
-- El front solo lee columnas públicas (TenantProvider, useTenantConfigEditor,
-- AjustesMarca usan listas explícitas) y solo escribe nombre/config/branding.
-- Idempotente.
-- ============================================================================

-- ── SELECT: todas menos las de Stripe, para anon y authenticated ─────────────
REVOKE SELECT ON tenants FROM PUBLIC;
REVOKE SELECT ON tenants FROM anon;
REVOKE SELECT ON tenants FROM authenticated;

GRANT SELECT (id, slug, nombre, vertical, branding, config, dominio_principal, dominio_app, status, created_at, updated_at)
  ON tenants TO anon;
GRANT SELECT (id, slug, nombre, vertical, branding, config, dominio_principal, dominio_app, status, created_at, updated_at)
  ON tenants TO authenticated;

-- ── UPDATE: solo lo que el admin edita desde la app ──────────────────────────
REVOKE UPDATE ON tenants FROM PUBLIC;
REVOKE UPDATE ON tenants FROM anon;
REVOKE UPDATE ON tenants FROM authenticated;
GRANT UPDATE (nombre, branding, config, dominio_principal, dominio_app, updated_at)
  ON tenants TO authenticated;

-- El backend (webhooks, Connect, crons) sigue con acceso total.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO service_role;

-- ── Self-test ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF has_column_privilege('anon', 'tenants', 'stripe_account_id', 'SELECT')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_account_id', 'SELECT')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'SELECT')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_details_submitted', 'SELECT')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_subscription_product_id', 'SELECT') THEN
    RAISE EXCEPTION 'tenants: las columnas stripe_* no deben ser legibles por anon/authenticated';
  END IF;
  IF has_column_privilege('authenticated', 'tenants', 'stripe_charges_enabled', 'UPDATE')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_account_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'tenants', 'slug', 'UPDATE')
     OR has_column_privilege('authenticated', 'tenants', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'tenants: authenticated no debe poder actualizar stripe_*/slug/status';
  END IF;
  IF NOT has_column_privilege('anon', 'tenants', 'nombre', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'tenants', 'config', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'tenants', 'config', 'UPDATE')
     OR NOT has_column_privilege('service_role', 'tenants', 'stripe_account_id', 'SELECT') THEN
    RAISE EXCEPTION 'tenants: los grants públicos/backend quedaron incompletos';
  END IF;
END $$;
