-- ============================================================================
-- Modelo de créditos PLANO: 1 crédito = 1 sesión en CUALQUIER estudio.
-- ----------------------------------------------------------------------------
-- Decisión: para el lanzamiento en Culiacán priorizamos simplicidad y ocupación
-- (los estudios están vacíos la mayor parte del tiempo). Se elimina el premium
-- "Estudios Pro = 2 créditos": todos los estudios cuestan lo mismo. El sello
-- Pro/Básica se retira del front (los estudios se distinguen por foto/nombre).
--
-- Idempotente. Reversible: se puede volver a subir costo_creditos por estudio y
-- reponer el beneficio desde Admin → Planes.
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

  -- 1. Todos los estudios cuestan 1 crédito.
  UPDATE recursos SET costo_creditos = 1 WHERE tenant_id = ekko_tenant_id;

  -- 2. Quitar el beneficio "Estudios Pro = 2 créditos" de los paquetes (ya no
  --    aplica en el modelo plano). Se conserva el resto de beneficios.
  UPDATE tiers
  SET beneficios = (
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements(beneficios) elem
    WHERE elem->>'label' NOT ILIKE '%Pro = 2%'
      AND elem->>'label' NOT ILIKE '%Estudios Pro%'
  )
  WHERE tenant_id = ekko_tenant_id
    AND slug IN ('sesion-suelta', 'starter', 'creador', 'pro-pack');

END $$;
