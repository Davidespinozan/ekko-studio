-- ============================================================================
-- Invitados como entidades (ficha por invitado) + base para cobrar extras
-- ----------------------------------------------------------------------------
-- Antes los invitados eran solo un número (reservas.invitados_count). El cliente
-- pide: (1) cada invitado registra nombre + foto en recepción; (2) poder cobrar
-- invitados EXTRA (arriba del tope del plan), en caja.
--
-- Tabla reserva_invitados: un registro por invitado de una reserva.
--   es_extra = true si va arriba del tope del plan (cobrado en recepción).
--   foto_path = ruta en el bucket privado 'identidad' (foto de la persona);
--     la URL firmada la genera el backend (como el INE) — nunca es pública.
--
-- Acceso: SOLO service_role (las Netlify Functions de recepción). RLS ON sin
-- policies para authenticated → el front pasa siempre por el backend, que valida
-- rol + tenant y firma las fotos. Mismo patrón que la ficha de identidad.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reserva_invitados (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  reserva_id  uuid NOT NULL REFERENCES reservas(id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  foto_path   text,
  es_extra    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS reserva_invitados_reserva_idx ON reserva_invitados (reserva_id);
CREATE INDEX IF NOT EXISTS reserva_invitados_tenant_idx  ON reserva_invitados (tenant_id);

ALTER TABLE reserva_invitados ENABLE ROW LEVEL SECURITY;
-- Sin policies para authenticated: todo el acceso va por las Netlify Functions
-- (service_role), que validan rol/tenant y generan las URLs firmadas de las fotos.

COMMENT ON TABLE reserva_invitados IS
  'Invitados registrados por reserva (nombre + foto). es_extra = cobrado arriba del tope del plan. Acceso solo por backend (service_role).';
