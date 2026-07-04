-- ============================================================================
-- Desactivar el plan de PRUEBA "HOLA" ($10/mes)
-- ----------------------------------------------------------------------------
-- Se creó para probar el cobro live de Stripe y quedó activo y visible para
-- clientes reales (aparecía en landing, registro y "Cambiar de plan"). Se
-- DESACTIVA (no se borra) para conservar el historial del cobro de prueba.
--
-- Filtro estrecho (nombre 'hola' + $10 exactos) para no tocar ningún plan real
-- por accidente. Idempotente: si ya está inactivo o no existe, no hace nada.
-- ============================================================================

UPDATE tiers
SET activo = false
WHERE activo = true
  AND lower(btrim(nombre)) = 'hola'
  AND precio_centavos = 1000;
