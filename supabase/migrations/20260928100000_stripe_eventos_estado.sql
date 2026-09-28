-- ============================================================================
-- PKG-01A · Estado durable de los eventos del webhook de Stripe
-- ============================================================================
-- Hasta hoy `stripe_webhook_events` solo sabía "recibido" (fila) y "terminó"
-- (processed_at). No podía responder qué llegó, qué debía pasar, qué pasó, si
-- terminó ni si necesita recuperación; un error de negocio BORRABA la fila y
-- un error permanente se reintentaba a ciegas hasta que Stripe se rendía sin
-- dejar rastro (C05, C06, C21).
--
-- Evolución ADITIVA de la misma tabla (no hay segunda journal):
--   estado      en_proceso | procesado | ignorado | error_reintentable | revision
--   intentos    cuántas veces se reclamó (cada entrega de Stripe que lo toma)
--   accion      qué debía pasar (kind de clasificarEvento)
--   motivo      por qué terminó así (ignorado/revision) o resultado (procesado)
--   ultimo_error, ultimo_intento_at, lease_hasta
--   stripe_account, livemode, event_created_at, api_version
--   resumen     ids del objeto (sin PII): suficiente para investigar en Stripe
--
-- `claim_stripe_event` es la ÚNICA puerta de entrada: reclama atómicamente
-- (INSERT … ON CONFLICT + SELECT … FOR UPDATE dentro de la función): un
-- event.id → una sola reclamación activa. Las entregas concurrentes que no la
-- obtienen NO ejecutan lógica de negocio (el webhook responde 503).
--
-- Historia: las 48 filas existentes recibieron `processed_at` por el backfill
-- de 20260920170000 (suposición, no observación). Aquí se hace explícito con
-- motivo `legacy_backfill_assumed_processed`. Ninguna fila histórica se borra
-- ni se reinterpreta como observada por esta máquina de estados.
-- ============================================================================

ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS estado            text NOT NULL DEFAULT 'en_proceso',
  ADD COLUMN IF NOT EXISTS intentos          integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accion            text,
  ADD COLUMN IF NOT EXISTS motivo            text,
  ADD COLUMN IF NOT EXISTS ultimo_error      text,
  ADD COLUMN IF NOT EXISTS ultimo_intento_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_hasta       timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_account    text,
  ADD COLUMN IF NOT EXISTS livemode          boolean,
  ADD COLUMN IF NOT EXISTS event_created_at  timestamptz,
  ADD COLUMN IF NOT EXISTS api_version       text,
  ADD COLUMN IF NOT EXISTS resumen           jsonb;

ALTER TABLE stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_estado_check,
  ADD CONSTRAINT stripe_webhook_events_estado_check
    CHECK (estado IN ('en_proceso', 'procesado', 'ignorado', 'error_reintentable', 'revision')),
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_intentos_check,
  ADD CONSTRAINT stripe_webhook_events_intentos_check CHECK (intentos >= 0);

COMMENT ON COLUMN stripe_webhook_events.estado IS
  'en_proceso: reclamado (lease). procesado/ignorado: terminales (200). error_reintentable: fallo transitorio (5xx, Stripe reintenta). revision: fallo permanente o divergencia; requiere humano; una re-entrega desde Stripe lo vuelve a reclamar.';
COMMENT ON COLUMN stripe_webhook_events.motivo IS
  'Regla que lo ignoró, divergencia que lo mandó a revisión, o resultado del procesado (activado, sync:activa, evento_viejo, conflicto…).';
COMMENT ON COLUMN stripe_webhook_events.resumen IS
  'Ids del objeto del evento (sin PII): object.id, subscription, customer, invoice, payment_intent, monto, metadata de EKKO.';

-- ── Backfill honesto de la historia ─────────────────────────────────────────
UPDATE stripe_webhook_events
SET estado = 'procesado',
    motivo = 'legacy_backfill_assumed_processed',
    intentos = GREATEST(intentos, 1)
WHERE processed_at IS NOT NULL
  AND estado = 'en_proceso'
  AND motivo IS NULL;

UPDATE stripe_webhook_events
SET estado = 'revision',
    motivo = 'legacy_backfill_unprocessed',
    intentos = GREATEST(intentos, 1)
WHERE processed_at IS NULL
  AND estado = 'en_proceso'
  AND motivo IS NULL;

-- ── Índice de atención (lo que un humano/02E debe mirar) ────────────────────
CREATE INDEX IF NOT EXISTS stripe_webhook_events_atencion_idx
  ON stripe_webhook_events (received_at)
  WHERE estado IN ('error_reintentable', 'revision');

-- ── Reclamación atómica ─────────────────────────────────────────────────────
-- Devuelve jsonb:
--   resultado: 'nuevo' | 'reclamado' | 'duplicado' | 'en_curso'
--   estado_previo, accion_previa, intentos, lease_hasta
-- Reglas:
--   · fila inexistente → INSERT en_proceso (nuevo).
--   · procesado / ignorado → duplicado (no se reclama; el webhook responde 200).
--   · en_proceso con lease vigente → en_curso (otro intento lo tiene; 503).
--   · en_proceso con lease vencido, error_reintentable, revision → reclamado
--     (intentos+1). Desde `revision` solo llega por una re-entrega manual desde
--     Stripe: ese es el mecanismo ejecutable de recuperación tras corregir la causa.
-- El SELECT … FOR UPDATE serializa a los concurrentes sobre la misma fila; el
-- INSERT … ON CONFLICT DO NOTHING serializa a los que llegan cuando aún no existe.
CREATE OR REPLACE FUNCTION claim_stripe_event(
  p_id text,
  p_type text,
  p_stripe_account text DEFAULT NULL,
  p_livemode boolean DEFAULT NULL,
  p_event_created_at timestamptz DEFAULT NULL,
  p_api_version text DEFAULT NULL,
  p_resumen jsonb DEFAULT NULL,
  p_lease_segundos integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now   timestamptz := now();
  v_lease timestamptz := now() + make_interval(secs => GREATEST(COALESCE(p_lease_segundos, 60), 1));
  v_fila  stripe_webhook_events;
BEGIN
  IF p_id IS NULL OR p_id = '' THEN
    RAISE EXCEPTION 'EKKO_EVENTO_SIN_ID: claim_stripe_event requiere p_id';
  END IF;

  INSERT INTO stripe_webhook_events
    (id, type, received_at, processed_at, estado, intentos, ultimo_intento_at, lease_hasta,
     stripe_account, livemode, event_created_at, api_version, resumen)
  VALUES
    (p_id, p_type, v_now, NULL, 'en_proceso', 1, v_now, v_lease,
     p_stripe_account, p_livemode, p_event_created_at, p_api_version, p_resumen)
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_fila;

  IF v_fila.id IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'nuevo', 'estado_previo', NULL, 'accion_previa', NULL,
                              'intentos', 1, 'lease_hasta', v_lease);
  END IF;

  SELECT * INTO v_fila FROM stripe_webhook_events WHERE id = p_id FOR UPDATE;

  IF v_fila.estado IN ('procesado', 'ignorado') THEN
    RETURN jsonb_build_object('resultado', 'duplicado', 'estado_previo', v_fila.estado,
                              'accion_previa', v_fila.accion, 'intentos', v_fila.intentos,
                              'lease_hasta', v_fila.lease_hasta);
  END IF;

  IF v_fila.estado = 'en_proceso' AND v_fila.lease_hasta IS NOT NULL AND v_fila.lease_hasta > v_now THEN
    RETURN jsonb_build_object('resultado', 'en_curso', 'estado_previo', v_fila.estado,
                              'accion_previa', v_fila.accion, 'intentos', v_fila.intentos,
                              'lease_hasta', v_fila.lease_hasta);
  END IF;

  -- en_proceso vencido (function muerta a medias), error_reintentable o revision.
  UPDATE stripe_webhook_events SET
    estado            = 'en_proceso',
    intentos          = v_fila.intentos + 1,
    ultimo_intento_at = v_now,
    lease_hasta       = v_lease,
    type              = COALESCE(type, p_type),
    stripe_account    = COALESCE(stripe_account, p_stripe_account),
    livemode          = COALESCE(livemode, p_livemode),
    event_created_at  = COALESCE(event_created_at, p_event_created_at),
    api_version       = COALESCE(api_version, p_api_version),
    resumen           = COALESCE(resumen, p_resumen)
  WHERE id = p_id;

  RETURN jsonb_build_object('resultado', 'reclamado', 'estado_previo', v_fila.estado,
                            'accion_previa', v_fila.accion, 'intentos', v_fila.intentos + 1,
                            'lease_hasta', v_lease);
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_stripe_event(text, text, text, boolean, timestamptz, text, jsonb, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_stripe_event(text, text, text, boolean, timestamptz, text, jsonb, integer)
  TO service_role;

COMMENT ON FUNCTION claim_stripe_event(text, text, text, boolean, timestamptz, text, jsonb, integer) IS
  'PKG-01A: reclamación atómica de un evento de Stripe por event.id (nuevo | reclamado | duplicado | en_curso). Solo service_role.';
