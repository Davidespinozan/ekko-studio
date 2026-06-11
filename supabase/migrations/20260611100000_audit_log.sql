-- ============================================================================
-- Bloque A — Gobernanza: audit_log insert-only
-- ============================================================================
-- Registro inmutable de acciones sensibles de recepción/admin sobre la cuenta
-- del miembro (cambio de status/tier, desbloqueo, reset de acceso, alta).
--
-- Reemplaza la "auditoría" previa que vivía como texto libre en
-- `usuarios.notas_admin` (borrable por admin → no confiable: B1/B2).
--
-- Inmutable POR CONSTRUCCIÓN: RLS habilitada, y NINGUNA policy de INSERT /
-- UPDATE / DELETE para `authenticated`. Las entradas las escribe solo
-- `service_role` (las Netlify Functions de recepción), que bypassa RLS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  actor_usuario_id uuid REFERENCES usuarios(id),  -- null si no hay caller (cron, service_role puro)
  actor_rol        text,                           -- 'recepcionista' | 'admin' | 'service_role' | ...
  accion           text NOT NULL,                  -- 'status_change' | 'tier_change' | 'unblock' | ...
  target_tipo      text NOT NULL,                  -- 'usuario' | 'reserva' | ...
  target_id        uuid NOT NULL,
  antes            jsonb,                           -- estado previo de los campos tocados
  despues          jsonb,                           -- estado nuevo de los campos tocados
  motivo           text,                            -- razón humana (obligatoria en status/tier/unblock)
  metadata         jsonb,                           -- contexto extra opcional
  creada_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_log IS
  'Insert-only audit log. No policies for UPDATE/DELETE on purpose — entries are immutable. Writes only via service_role (Netlify Functions).';

CREATE INDEX IF NOT EXISTS audit_log_tenant_target_idx
  ON audit_log (tenant_id, target_tipo, target_id, creada_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_creada_idx
  ON audit_log (tenant_id, creada_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- SELECT admin: ve TODO el audit log de su tenant.
DROP POLICY IF EXISTS audit_log_select_admin ON audit_log;
CREATE POLICY audit_log_select_admin ON audit_log
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

-- SELECT recepción: solo entradas sobre USUARIOS de su tenant (historial del
-- miembro en el perfil). Como cada fila lleva el tenant del target, filtrar por
-- tenant_id + target_tipo='usuario' equivale a "usuarios de mi tenant".
DROP POLICY IF EXISTS audit_log_select_recepcion ON audit_log;
CREATE POLICY audit_log_select_recepcion ON audit_log
  FOR SELECT TO authenticated
  USING (
    tenant_id = get_my_tenant_id()
    AND is_recepcionista()
    AND target_tipo = 'usuario'
  );

-- INSERT / UPDATE / DELETE: SIN policies a propósito. Con RLS habilitada eso
-- bloquea toda escritura desde `authenticated`. service_role bypassa RLS y es
-- la única vía de escritura (Netlify Functions).
REVOKE INSERT, UPDATE, DELETE ON audit_log FROM authenticated, anon;
GRANT SELECT ON audit_log TO authenticated;
GRANT SELECT, INSERT ON audit_log TO service_role;
