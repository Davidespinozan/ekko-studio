-- ============================================================================
-- PKG-00F · Evidencia veraz del correo (C03)
-- ----------------------------------------------------------------------------
-- Antes `cron-email` marcaba `email_enviado_at` en un `finally`: también cuando
-- Resend fallaba o el usuario no tenía correo. Una fila "enviada" no probaba
-- nada. Desde aquí:
--
--   email_resultado     aceptado   → Resend ACEPTÓ la solicitud (hay id).
--                       sin_correo → el usuario no tiene correo; no se intentó.
--                       fallo      → no se pudo entregar la solicitud al proveedor.
--   email_proveedor_id  id que devolvió Resend (solo con `aceptado`).
--   email_enviado_at    desde 00F significa "Resend aceptó". NUNCA "entregado":
--                       PROVIDER ACCEPTED ≠ DELIVERED (lifecycle: 02C/02D).
--
-- HISTÓRICO: las filas marcadas antes de 00F conservan `email_enviado_at` con
-- `email_resultado = NULL`. No se reinterpretan ni se limpian: limitación
-- conocida. Los CHECK solo rigen cuando `email_resultado` tiene valor.
--
-- Sin reintentos aquí: una fila con resultado no se vuelve a tomar (02C).
-- El índice parcial existente `notificaciones_email_pendiente_idx`
-- (WHERE email_enviado_at IS NULL) ya cubre el predicado del cron
-- (… AND email_resultado IS NULL): no se crea otro.
-- Aditiva: sin DROP, sin UPDATE, sin cambios en RPC ni triggers.
-- ============================================================================

ALTER TABLE notificaciones
  ADD COLUMN IF NOT EXISTS email_resultado text,
  ADD COLUMN IF NOT EXISTS email_proveedor_id text;

ALTER TABLE notificaciones
  ADD CONSTRAINT notificaciones_email_resultado_check
  CHECK (email_resultado IS NULL OR email_resultado IN ('aceptado', 'sin_correo', 'fallo'));

-- aceptado ⇒ hay id del proveedor y marca de aceptación.
ALTER TABLE notificaciones
  ADD CONSTRAINT notificaciones_email_aceptado_check
  CHECK (email_resultado IS DISTINCT FROM 'aceptado'
         OR (email_proveedor_id IS NOT NULL AND email_enviado_at IS NOT NULL));

-- sin_correo / fallo ⇒ no hay id ni marca: nunca "enviado" sin aceptación.
ALTER TABLE notificaciones
  ADD CONSTRAINT notificaciones_email_no_aceptado_check
  CHECK (email_resultado IS NULL OR email_resultado = 'aceptado'
         OR (email_proveedor_id IS NULL AND email_enviado_at IS NULL));

COMMENT ON COLUMN notificaciones.email_resultado IS
  'PKG-00F: aceptado (Resend aceptó, hay id) | sin_correo | fallo. NULL = pendiente o histórico anterior a 00F.';
COMMENT ON COLUMN notificaciones.email_proveedor_id IS
  'PKG-00F: id del email en Resend. Solo con email_resultado = aceptado.';
COMMENT ON COLUMN notificaciones.email_enviado_at IS
  'Desde PKG-00F: instante en que Resend ACEPTÓ la solicitud. No significa entregado.';
