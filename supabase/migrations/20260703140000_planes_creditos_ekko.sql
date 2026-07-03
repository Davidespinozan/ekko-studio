-- ============================================================================
-- Planes de EKKO v1: SOLO CRÉDITOS (paquetes que vencen)
-- ----------------------------------------------------------------------------
-- Modelo elegido: créditos primero (economía de Culiacán + capacidad escasa).
-- 1 crédito = 1 sesión. Estudios Pro cuestan 2 créditos (recursos.costo_creditos).
-- Cuatro paquetes con descuento por volumen; todos vencen (tipo 'hibrido').
--
-- NO destructivo: los planes mensuales (basica/pro) quedan ACTIVOS para no romper
-- el signup/landing actuales (eso se rehace en la Fase 2). Acá solo se agregan los
-- paquetes y se configuran los estudios.
--
-- Idempotente: ON CONFLICT por (tenant_id, slug). Reversible: los paquetes se
-- pueden desactivar; nada se borra.
-- ============================================================================

DO $$
DECLARE
  ekko_tenant_id uuid;
BEGIN
  SELECT id INTO ekko_tenant_id FROM tenants WHERE slug = 'ekko';
  IF ekko_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant ekko no encontrado — se omite el seed de paquetes.';
    RETURN;
  END IF;

  -- ── 1. Los 4 paquetes de créditos ─────────────────────────────────────────
  -- precio_centavos en MXN. tipo 'hibrido' = N sesiones que vencen en N días.
  INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo,
                     tipo, clases_incluidas, duracion_dias, beneficios, activo, orden)
  VALUES
    (ekko_tenant_id, 'sesion-suelta', 'Sesión suelta',
     'Una sesión para probar o uso puntual.', 25000, 'MXN', 'mensual',
     'hibrido', 1, 30,
     '[{"label":"1 sesión","incluido":true},{"label":"Acceso a todos los estudios","incluido":true},{"label":"Estudios Pro = 2 créditos","incluido":true},{"label":"Vence en 30 días","incluido":true}]'::jsonb,
     true, 1),

    (ekko_tenant_id, 'starter', 'Starter',
     'Para tu primer proyecto. 3 sesiones con descuento.', 65000, 'MXN', 'mensual',
     'hibrido', 3, 90,
     '[{"label":"3 sesiones","incluido":true},{"label":"Acceso a todos los estudios","incluido":true},{"label":"Estudios Pro = 2 créditos","incluido":true},{"label":"Vence en 90 días","incluido":true}]'::jsonb,
     true, 2),

    (ekko_tenant_id, 'creador', 'Creador',
     'El mejor valor. 6 sesiones para producir seguido.', 115000, 'MXN', 'mensual',
     'hibrido', 6, 90,
     '[{"label":"6 sesiones","incluido":true},{"label":"Acceso a todos los estudios","incluido":true},{"label":"Estudios Pro = 2 créditos","incluido":true},{"label":"Vence en 90 días","incluido":true},{"label":"Mejor precio por sesión","incluido":true}]'::jsonb,
     true, 3),

    (ekko_tenant_id, 'pro-pack', 'Pro Pack',
     'Para el que graba mucho. 12 sesiones al mejor precio.', 199000, 'MXN', 'mensual',
     'hibrido', 12, 120,
     '[{"label":"12 sesiones","incluido":true},{"label":"Acceso a todos los estudios","incluido":true},{"label":"Estudios Pro = 2 créditos","incluido":true},{"label":"Vence en 120 días","incluido":true},{"label":"El precio por sesión más bajo","incluido":true}]'::jsonb,
     true, 4)
  ON CONFLICT (tenant_id, slug) DO NOTHING;

  -- ── 2. Costo en créditos por estudio (ANTES de tocar tiers_permitidos) ─────
  -- Pro = estudio que NO admite el plan mensual 'basica' (era exclusivo Pro) → 2.
  -- El resto (Básicos) → 1. Regla, no slugs hardcodeados (hay 5 estudios reales).
  UPDATE recursos
  SET costo_creditos = 2
  WHERE tenant_id = ekko_tenant_id
    AND NOT ('basica' = ANY(tiers_permitidos));

  UPDATE recursos
  SET costo_creditos = 1
  WHERE tenant_id = ekko_tenant_id
    AND 'basica' = ANY(tiers_permitidos);

  -- ── 3. Permitir que los planes de crédito reserven en TODOS los estudios ───
  -- Se AGREGAN los slugs de paquete a tiers_permitidos (sin quitar basica/pro,
  -- para no romper a miembros mensuales durante la transición).
  UPDATE recursos
  SET tiers_permitidos = (
    SELECT ARRAY(
      SELECT DISTINCT unnest(
        tiers_permitidos || ARRAY['sesion-suelta', 'starter', 'creador', 'pro-pack']
      )
    )
  )
  WHERE tenant_id = ekko_tenant_id;

END $$;
