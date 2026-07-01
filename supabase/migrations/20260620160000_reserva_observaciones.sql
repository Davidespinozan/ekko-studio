-- ============================================================================
-- Observaciones de sesión en la reserva (expediente del miembro)
-- ============================================================================
-- Feedback del cliente: en el detalle de reserva poder anotar observaciones
-- (ej. "mal uso de equipo", "compró 30 min extra", nº de invitados) para ir
-- generando un expediente. `reservas.observaciones` es la nota del ESTUDIO
-- sobre la sesión — distinta de `reservas.notas` (nota del miembro al reservar).
-- La escribe recepción/admin vía la Netlify Function `reception-observar-reserva`
-- (service_role + audit_log); el miembro NO la ve ni la edita.
-- ============================================================================

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS observaciones text;

COMMENT ON COLUMN reservas.observaciones IS
  'Nota del estudio sobre la sesión (expediente): mal uso de equipo, compras extra, etc. La escribe staff, no el miembro.';
