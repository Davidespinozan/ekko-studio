-- ============================================================================
-- Índices que faltaban en las consultas calientes (SALA_PARITY_AUDIT_2 §3.6 T6)
-- ============================================================================
-- Todos los crons y reportes filtraban por columnas sin índice útil (los que
-- había llevaban `tenant_id` delante y no sirven para un barrido global):
--  · `generar_recordatorios_reservas` (cada pocos min) y `marcar_no_shows` recorren
--    `reservas` por status + fecha → índices parciales sobre lo CONFIRMADO.
--  · Historial de cobros por miembro, "cobrado real" y el lookup del reembolso
--    leen `payment_events` por usuario / payment_intent / (tenant, fecha).
--  · `mov_read_admin` y los reportes de créditos leen el ledger por tenant; la FK
--    `membresia_id … ON DELETE CASCADE` no tenía índice (cada borrado, seq scan).
-- (SALA 20260524000000, 20260709170000, 20260713100000.)
-- Sin CONCURRENTLY: las tablas son chicas hoy y Supabase corre las migraciones en
-- una transacción.

CREATE INDEX IF NOT EXISTS reservas_recordatorio_pendiente_idx
  ON reservas (slot_inicio)
  WHERE status = 'confirmada' AND recordatorio_enviado_at IS NULL;

CREATE INDEX IF NOT EXISTS reservas_no_show_pendiente_idx
  ON reservas (slot_fin)
  WHERE status = 'confirmada' AND check_in_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_events_usuario_idx
  ON payment_events (usuario_id, created_at DESC) WHERE usuario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_events_pi_idx
  ON payment_events (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_events_tenant_fecha_idx
  ON payment_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mov_membresia_idx
  ON membresia_movimientos (membresia_id, created_at);

CREATE INDEX IF NOT EXISTS mov_tenant_fecha_idx
  ON membresia_movimientos (tenant_id, created_at DESC);
