-- ============================================================================
-- "Pro" coherente en los DOS modelos (membresía + créditos)
-- ----------------------------------------------------------------------------
-- Antes coexistían 3 reglas peleándose: Black Pro-only (semilla), Estudio 1/2 a
-- 2 créditos (migración de créditos) y membresías con acceso a todo (migración
-- de membresías). Se unifica en UNA sola fuente de verdad: costo_creditos.
--
--   Estudio ESTÁNDAR (costo_creditos = 1):
--     → lo reservan Esencial, Premium y todos los paquetes (1 crédito).
--   Estudio PRO (costo_creditos = 2):
--     → lo reservan PREMIUM y paquetes (2 créditos). Esencial NO.
--
-- Así, marcar un estudio como "2 créditos" lo vuelve Pro en ambos modelos a la
-- vez. El gate ya se respeta en el backend (la reserva valida tiers_permitidos).
--
-- Pro = Estudio 1 y Estudio 2 (los más bonitos, según el dueño). El resto,
-- estándar. Cambiar cuál es Pro = editar costo_creditos en admin.
-- Idempotente. Reversible.
-- ============================================================================

DO $$
DECLARE
  ekko_tenant_id uuid;
BEGIN
  SELECT id INTO ekko_tenant_id FROM tenants WHERE slug = 'ekko';
  IF ekko_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant ekko no encontrado — se omite.';
    RETURN;
  END IF;

  -- ── 1. Definición única de "Pro" = costo_creditos ─────────────────────────
  -- Reset a estándar y marca los Pro (Estudio 1 y 2, los más bonitos).
  UPDATE recursos SET costo_creditos = 1 WHERE tenant_id = ekko_tenant_id;
  UPDATE recursos SET costo_creditos = 2
    WHERE tenant_id = ekko_tenant_id
      AND (slug IN ('estudio-1', 'estudio-2') OR nombre IN ('Estudio 1', 'Estudio 2'));

  -- ── 2. tiers_permitidos DERIVADO de costo_creditos ────────────────────────
  -- Estándar → todos los planes. Pro → todos menos 'esencial'.
  -- (Robusto a N estudios: aplica a los que existan, sin listarlos uno por uno.)
  UPDATE recursos
    SET tiers_permitidos = ARRAY['esencial', 'premium', 'sesion-suelta', 'starter', 'creador', 'pro-pack']
    WHERE tenant_id = ekko_tenant_id AND costo_creditos = 1;

  UPDATE recursos
    SET tiers_permitidos = ARRAY['premium', 'sesion-suelta', 'starter', 'creador', 'pro-pack']
    WHERE tenant_id = ekko_tenant_id AND costo_creditos >= 2;

END $$;
