-- ============================================================================
-- Notificaciones push (Web Push / PWA) — tabla de suscripciones
-- ============================================================================
-- Complementa las notificaciones IN-APP (tabla `notificaciones`) con ENTREGA
-- fuera de la app: cada dispositivo/navegador que acepta avisos guarda acá su
-- endpoint push + llaves. El envío lo hace la Netlify Function `push-send`
-- (paquete `web-push`) con `service_role`. Patrón tomado de HSC.
--
-- Una fila por dispositivo (UNIQUE endpoint): un mismo usuario puede tener push
-- en su teléfono y en el iPad. Las suscripciones muertas (410/404 al enviar) las
-- borra la función en runtime.
-- ============================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

  endpoint   text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  user_agent text,                               -- para que el usuario identifique el dispositivo

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS push_subs_usuario_idx ON push_subscriptions (usuario_id);
CREATE INDEX IF NOT EXISTS push_subs_tenant_idx  ON push_subscriptions (tenant_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- El dueño gestiona SOLO las suyas (mapeo auth.uid() → usuarios.auth_id).
-- El envío va por service_role (bypassa RLS). No hay UPDATE: re-suscribir = upsert
-- por endpoint (INSERT; si ya existe el endpoint, el cliente refresca sus llaves).
DROP POLICY IF EXISTS "push_subs_select_self" ON push_subscriptions;
CREATE POLICY "push_subs_select_self" ON push_subscriptions
  FOR SELECT TO authenticated
  USING (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()));

DROP POLICY IF EXISTS "push_subs_insert_self" ON push_subscriptions;
CREATE POLICY "push_subs_insert_self" ON push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()));

DROP POLICY IF EXISTS "push_subs_update_self" ON push_subscriptions;
CREATE POLICY "push_subs_update_self" ON push_subscriptions
  FOR UPDATE TO authenticated
  USING (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()))
  WITH CHECK (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()));

DROP POLICY IF EXISTS "push_subs_delete_self" ON push_subscriptions;
CREATE POLICY "push_subs_delete_self" ON push_subscriptions
  FOR DELETE TO authenticated
  USING (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()));
