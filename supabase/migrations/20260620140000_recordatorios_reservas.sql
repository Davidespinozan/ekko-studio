-- ============================================================================
-- Recordatorios de reserva próxima (motor de push proactivo)
-- ============================================================================
-- Un cron (Netlify scheduled function `cron-recordatorios`) llama a este RPC
-- cada pocos minutos. El RPC:
--   1. Toma las reservas 'confirmada' que empiezan en ~1 hora y NO tienen
--      recordatorio enviado (dedupe por `recordatorio_enviado_at`).
--   2. Las marca (mismo statement → atómico, sin dobles ni carreras entre crons).
--   3. Inserta la notificación in-app (`tipo='recordatorio_reserva'`).
--   4. DEVUELVE las filas para que el cron dispare el push (entrega en Node).
--
-- Timezone: la hora que se muestra al miembro se ancla a 'America/Mazatlan'
-- (L-01); la elegibilidad compara timestamptz en UTC, así que el cron puede
-- correr en UTC sin bugs de offset.
-- ============================================================================

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS recordatorio_enviado_at timestamptz;

COMMENT ON COLUMN reservas.recordatorio_enviado_at IS
  'Cuándo se generó el recordatorio de "tu reserva es pronto". Dedupe del cron.';

CREATE OR REPLACE FUNCTION generar_recordatorios_reservas()
RETURNS TABLE(usuario_id uuid, titulo text, mensaje text, reserva_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH marcadas AS (
    UPDATE reservas r
    SET recordatorio_enviado_at = now()
    WHERE r.status = 'confirmada'
      AND r.recordatorio_enviado_at IS NULL
      AND r.slot_inicio BETWEEN now() + interval '55 minutes'
                            AND now() + interval '70 minutes'
    RETURNING r.id, r.tenant_id, r.usuario_id, r.slot_inicio
  ),
  insertadas AS (
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    SELECT
      m.tenant_id,
      m.usuario_id,
      'recordatorio_reserva',
      'Tu reserva es pronto',
      'Tu sesión empieza a las '
        || to_char(m.slot_inicio AT TIME ZONE 'America/Mazatlan', 'HH24:MI')
        || ' hs. ¡Te esperamos!',
      jsonb_build_object('reserva_id', m.id)
    FROM marcadas m
    RETURNING
      notificaciones.usuario_id,
      notificaciones.titulo,
      notificaciones.mensaje,
      (notificaciones.metadata ->> 'reserva_id')::uuid AS reserva_id
  )
  SELECT i.usuario_id, i.titulo, i.mensaje, i.reserva_id FROM insertadas i;
END;
$$;

-- Solo el backend (service_role) lo corre, desde el cron.
REVOKE EXECUTE ON FUNCTION generar_recordatorios_reservas() FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION generar_recordatorios_reservas() TO service_role;
