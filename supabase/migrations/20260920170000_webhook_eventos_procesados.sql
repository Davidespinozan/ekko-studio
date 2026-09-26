-- ============================================================================
-- Webhook de Stripe: un evento "recibido" no es un evento "procesado"
-- ============================================================================
-- La idempotencia era insertar-primero: `stripe_webhook_events(id)` se escribe al
-- recibir el evento y, si algo LANZA, el catch borra la fila para que Stripe
-- reintente. Pero si la function MUERE a medias (timeout de Netlify, OOM, un
-- fetch colgado) no hay catch: la fila queda, el reintento de Stripe responde
-- "duplicate" y el evento se pierde para siempre — "pagó y no se le activó",
-- sin ningún error a la vista.
--
-- `processed_at` separa las dos cosas. El webhook lo marca cuando la acción de
-- dinero terminó; un reintento que encuentra la fila SIN `processed_at` y con
-- más de un minuto de recibida la reclama y la reprocesa (las RPC son
-- idempotentes: activar por suscripción/referencia de pago, sync por orden).
-- ============================================================================

ALTER TABLE stripe_webhook_events ADD COLUMN IF NOT EXISTS processed_at timestamptz;

-- Lo recibido antes de esta migración se da por procesado: no hay forma de
-- saberlo y reprocesar en masa eventos viejos sería peor.
UPDATE stripe_webhook_events SET processed_at = received_at WHERE processed_at IS NULL;

COMMENT ON COLUMN stripe_webhook_events.processed_at IS
  'Cuándo terminó la acción del evento. NULL = se recibió pero el proceso no terminó (function muerta a medias): el reintento de Stripe lo reclama.';

CREATE INDEX IF NOT EXISTS stripe_webhook_events_pendientes_idx
  ON stripe_webhook_events (received_at) WHERE processed_at IS NULL;
