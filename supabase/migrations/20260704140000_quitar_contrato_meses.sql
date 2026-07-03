-- ============================================================================
-- Quitar el compromiso mínimo de 6 meses de las membresías
-- ----------------------------------------------------------------------------
-- Decisión del dueño (2026-07-04): las membresías serán mes a mes, sin
-- permanencia. Se retira la clave reglas.contrato_meses que se había sembrado
-- en 20260704120000 (nunca llegó a aplicarse: solo era dato, sin enforcement).
--
-- Solo toca los planes que la tengan. Idempotente.
-- ============================================================================

UPDATE tiers
SET reglas = reglas - 'contrato_meses'
WHERE reglas ? 'contrato_meses';
