-- ============================================================================
-- F-1 · Aislar las vistas de valor (`valor_por_lote`, `movimientos_sin_vinculo`)
-- ----------------------------------------------------------------------------
-- Hallazgo (auditoría de confiabilidad operativa, 2026-10-05): ambas vistas se
-- crearon en 20261002100000 sin `security_invoker`, con dueño `postgres` (salta
-- RLS) y sin filtro de tenant, y con SELECT para `anon` y `authenticated`. Con la
-- llave pública cualquiera leía el agregado del ledger de valor de todos los
-- estudios (usuario, membresía, origen, otorgado/retirado, fechas).
--
-- Arreglo mínimo, sin cambiar la definición ni la semántica económica:
--  - `security_invoker = true`: la vista se evalúa con los permisos de quien
--    consulta, así que manda la RLS de `membresia_movimientos` (admin de su
--    tenant, o el propio miembro sobre sus movimientos), igual que la tabla.
--  - `anon` y PUBLIC sin ningún privilegio; `authenticated` solo SELECT (se quita
--    el MAINTAIN que traía el default); `service_role` y el dueño sin cambio.
-- Sin SECURITY DEFINER, sin datos, sin tocar migraciones históricas.
-- Pruebas: src/__tests__/db/f1-vistas-valor.db.test.ts · hardening_checks.sql §P5
-- ============================================================================

ALTER VIEW public.valor_por_lote SET (security_invoker = true);
ALTER VIEW public.movimientos_sin_vinculo SET (security_invoker = true);

REVOKE ALL ON public.valor_por_lote, public.movimientos_sin_vinculo FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.valor_por_lote, public.movimientos_sin_vinculo TO authenticated;
