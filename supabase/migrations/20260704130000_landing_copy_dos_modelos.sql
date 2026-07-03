-- ============================================================================
-- Copy del landing coherente con los DOS modelos (membresía + créditos)
-- ----------------------------------------------------------------------------
-- El copy sembrado en la fase 1 era herencia del gimnasio (STRYV): prometía
-- "horas ilimitadas según tu membresía", que es falso — EKKO es sesiones (60
-- min) con membresía mensual o paquete de créditos. Se corrige el hero y se
-- alinea la terminología a "planes" (paraguas de membresía + paquete).
--
-- jsonb_set puntual por clave: NO clobbea el resto de config.landing.
-- Idempotente. Reversible (otro jsonb_set).
-- ============================================================================

UPDATE tenants
SET config = jsonb_set(
  jsonb_set(
    jsonb_set(
      config,
      '{landing,hero,subtitulo}',
      '"La plataforma para creadores que quieren grabar, crear y crecer al siguiente nivel. Equipo profesional, espacios diseñados y sesiones cuando las necesites."'::jsonb,
      true
    ),
    '{landing,hero,cta_texto}',
    '"Ver planes →"'::jsonb,
    true
  ),
  '{landing,cta_final,subtitulo}',
  '"Agenda una visita sin compromiso. Te mostramos los estudios y te ayudamos a elegir tu plan."'::jsonb,
  true
)
WHERE slug = 'ekko';
