-- ============================================================================
-- Membresías mensuales de EKKO (el producto principal del cliente)
-- ----------------------------------------------------------------------------
-- El cliente definió DOS membresías mensuales (acceso, no créditos):
--   Esencial $850/mes · Premium $1200/mes.
-- Features (de la nota del cliente):
--   • Membresía personal e intransferible   • Graba todos los días
--   • Hasta 60 min por sesión               • Material entregado en MP4
--   • Invitados: 2 (Esencial) / 4 (Premium)
--   • Premium agrega: edición básica IA (CapCut) + 2 miniaturas por video
--   Letra chiquita: pago automático mensual, sin permanencia (mes a mes).
--
-- Conviven con los paquetes de créditos (uso puntual, sin mensualidad). En la
-- landing se separan por pestaña (Membresías · Paquetes) para no saturar.
--
-- tipo 'tiempo' = acceso mensual recurrente (NO decrementa créditos). El de
-- Premium queda marcado reglas.recomendado (dorado + estrella en el landing).
-- reglas.max_invitados lo lee el backend para el límite de invitados por reserva.
--
-- Desactiva los planes viejos basica/pro (fantasma) para que no aparezcan.
-- Idempotente: ON CONFLICT (tenant_id, slug) DO UPDATE. Reversible.
-- ============================================================================

DO $$
DECLARE
  ekko_tenant_id uuid;
BEGIN
  SELECT id INTO ekko_tenant_id FROM tenants WHERE slug = 'ekko';
  IF ekko_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant ekko no encontrado — se omite el seed de membresías.';
    RETURN;
  END IF;

  -- ── 1. Las 2 membresías mensuales ─────────────────────────────────────────
  -- tipo 'tiempo': acceso mensual; clases_incluidas/duracion_dias = NULL.
  INSERT INTO tiers (tenant_id, slug, nombre, descripcion, precio_centavos, moneda, periodo,
                     tipo, clases_incluidas, duracion_dias, beneficios, reglas, activo, orden)
  VALUES
    (ekko_tenant_id, 'esencial', 'Esencial',
     'Graba todos los días con tu espacio y equipo listos.', 85000, 'MXN', 'mensual',
     'tiempo', NULL, NULL,
     '[{"label":"Membresía personal e intransferible","incluido":true},
       {"label":"Graba todos los días","incluido":true},
       {"label":"Hasta 60 min por sesión","incluido":true},
       {"label":"Material entregado en MP4","incluido":true},
       {"label":"Hasta 2 invitados","incluido":true},
       {"label":"Edición básica con IA (CapCut)","incluido":false},
       {"label":"2 miniaturas por video","incluido":false}]'::jsonb,
     '{"max_invitados": 2}'::jsonb,
     true, 1),

    (ekko_tenant_id, 'premium', 'Premium',
     'Todo lo de Esencial más edición con IA y miniaturas.', 120000, 'MXN', 'mensual',
     'tiempo', NULL, NULL,
     '[{"label":"Membresía personal e intransferible","incluido":true},
       {"label":"Graba todos los días","incluido":true},
       {"label":"Hasta 60 min por sesión","incluido":true},
       {"label":"Material entregado en MP4","incluido":true},
       {"label":"Hasta 4 invitados","incluido":true},
       {"label":"Edición básica con IA (CapCut)","incluido":true},
       {"label":"2 miniaturas por video","incluido":true}]'::jsonb,
     '{"max_invitados": 4, "recomendado": true}'::jsonb,
     true, 2)
  ON CONFLICT (tenant_id, slug) DO UPDATE
    SET nombre = EXCLUDED.nombre,
        descripcion = EXCLUDED.descripcion,
        precio_centavos = EXCLUDED.precio_centavos,
        moneda = EXCLUDED.moneda,
        periodo = EXCLUDED.periodo,
        tipo = EXCLUDED.tipo,
        clases_incluidas = EXCLUDED.clases_incluidas,
        duracion_dias = EXCLUDED.duracion_dias,
        beneficios = EXCLUDED.beneficios,
        reglas = EXCLUDED.reglas,
        activo = EXCLUDED.activo,
        orden = EXCLUDED.orden;

  -- ── 2. Los paquetes de créditos pasan después de las membresías ───────────
  -- (orden global; en la landing se agrupan por tipo, pero así también quedan
  --  bien si algún día se muestran en una sola reja.)
  UPDATE tiers SET orden = 3 WHERE tenant_id = ekko_tenant_id AND slug = 'sesion-suelta';
  UPDATE tiers SET orden = 4 WHERE tenant_id = ekko_tenant_id AND slug = 'starter';
  UPDATE tiers SET orden = 5 WHERE tenant_id = ekko_tenant_id AND slug = 'creador';
  UPDATE tiers SET orden = 6 WHERE tenant_id = ekko_tenant_id AND slug = 'pro-pack';

  -- ── 3. Desactivar los planes viejos fantasma (basica/pro) ─────────────────
  UPDATE tiers SET activo = false
  WHERE tenant_id = ekko_tenant_id AND slug IN ('basica', 'pro');

  -- ── 4. Permitir que las membresías reserven en TODOS los estudios ─────────
  UPDATE recursos
  SET tiers_permitidos = (
    SELECT ARRAY(
      SELECT DISTINCT unnest(tiers_permitidos || ARRAY['esencial', 'premium'])
    )
  )
  WHERE tenant_id = ekko_tenant_id;

END $$;
