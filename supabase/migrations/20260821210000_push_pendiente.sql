-- ============================================================================
-- Push central: toda notificación lleva push_enviado_at; cron-push reparte lo pendiente
-- ============================================================================
-- El push estaba cableado disparador por disparador (`enviarPushAUsuario` en 3
-- functions): las notificaciones que inserta la BASE (cancelación por RPC,
-- no-show del cron, avisos por vencer, felicitaciones, cambiar_password) no
-- llegaban al teléfono. Ahora `notificaciones.push_enviado_at` marca qué ya se
-- repartió; `cron-push` (cada minuto) manda el resto y lo marca. Las functions
-- que siguen mandando inline ponen push_enviado_at al insertar para no duplicar.
-- Backfill: lo histórico se marca como enviado (no se dispara un aluvión).
-- (SALA aa4a34d.) Idempotente.
-- ============================================================================

ALTER TABLE notificaciones ADD COLUMN IF NOT EXISTS push_enviado_at timestamptz;
COMMENT ON COLUMN notificaciones.push_enviado_at IS
  'Cuándo se repartió el push de esta notificación (NULL = pendiente; lo manda cron-push). Las functions que empujan inline lo fijan al insertar.';

UPDATE notificaciones SET push_enviado_at = creada_at WHERE push_enviado_at IS NULL;

CREATE INDEX IF NOT EXISTS notificaciones_push_pendiente_idx
  ON notificaciones (creada_at)
  WHERE push_enviado_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notificaciones' AND column_name = 'push_enviado_at') THEN
    RAISE EXCEPTION 'falta notificaciones.push_enviado_at';
  END IF;
END $$;
