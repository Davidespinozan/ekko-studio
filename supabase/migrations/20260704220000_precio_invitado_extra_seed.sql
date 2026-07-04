-- ============================================================================
-- EKKO arranca con precio de invitado extra = $100 MXN (10000 centavos)
-- ----------------------------------------------------------------------------
-- Se cobra en caja por cada invitado arriba del tope del plan. Editable en
-- Admin → Reglas → Invitados. Solo siembra si aún no está configurado (no pisa
-- lo que el admin haya puesto). Idempotente.
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(config, '{reserva,precio_invitado_extra_centavos}', '10000'::jsonb, true)
WHERE slug = 'ekko'
  AND NOT (COALESCE(config->'reserva', '{}'::jsonb) ? 'precio_invitado_extra_centavos');
