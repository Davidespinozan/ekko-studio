-- ============================================================================
-- Bloque E — notas_miembro: bitácora operativa compartida del miembro
-- ============================================================================
-- Notas humanas que admin Y recepción del tenant pueden dejar/leer sobre un
-- miembro ("traer foto", "viene los viernes", "preguntar por su plan").
--
-- Separada de:
--   - usuarios.notas_admin (notas privadas que solo admin edita; intacta).
--   - audit_log (log inmutable de acciones sensibles; las notas NO van ahí —
--     son colaboración humana editable, no auditoría).
-- ============================================================================

CREATE TABLE IF NOT EXISTS notas_miembro (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  miembro_id     uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  autor_id       uuid NOT NULL REFERENCES usuarios(id),
  autor_rol      text NOT NULL,              -- 'admin' | 'recepcionista' (snapshot al crear)
  contenido      text NOT NULL,
  creada_at      timestamptz NOT NULL DEFAULT now(),
  actualizada_at timestamptz
);

CREATE INDEX IF NOT EXISTS notas_miembro_tenant_miembro_idx
  ON notas_miembro (tenant_id, miembro_id, creada_at DESC);

ALTER TABLE notas_miembro ENABLE ROW LEVEL SECURITY;

-- SELECT: admin + recepción del tenant.
DROP POLICY IF EXISTS notas_miembro_select ON notas_miembro;
CREATE POLICY notas_miembro_select ON notas_miembro
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_recepcionista());

-- INSERT: admin + recepción del tenant; el autor debe ser uno mismo (defensa
-- en profundidad: aunque la UI lo pase bien, la policy lo enforce).
DROP POLICY IF EXISTS notas_miembro_insert ON notas_miembro;
CREATE POLICY notas_miembro_insert ON notas_miembro
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = get_my_tenant_id()
    AND is_recepcionista()
    AND autor_id = get_my_user_id()
  );

-- UPDATE: el propio autor O cualquier admin del tenant. Recepción NO reescribe
-- la nota de otro recepcionista (evita reescritura silenciosa).
DROP POLICY IF EXISTS notas_miembro_update ON notas_miembro;
CREATE POLICY notas_miembro_update ON notas_miembro
  FOR UPDATE TO authenticated
  USING (tenant_id = get_my_tenant_id() AND (autor_id = get_my_user_id() OR is_admin()))
  WITH CHECK (tenant_id = get_my_tenant_id() AND (autor_id = get_my_user_id() OR is_admin()));

-- DELETE: el propio autor O admin del tenant.
DROP POLICY IF EXISTS notas_miembro_delete ON notas_miembro;
CREATE POLICY notas_miembro_delete ON notas_miembro
  FOR DELETE TO authenticated
  USING (tenant_id = get_my_tenant_id() AND (autor_id = get_my_user_id() OR is_admin()));

GRANT SELECT, INSERT, UPDATE, DELETE ON notas_miembro TO authenticated;

COMMENT ON TABLE notas_miembro IS
  'Bloque E: bitácora operativa compartida (admin + recepción del tenant). NO es auditoría — las notas son editables. Separada de usuarios.notas_admin y de audit_log.';
