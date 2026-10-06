-- ============================================================================
-- PKG-06D (B) · Frontera de COLUMNAS para el cliente (EKKO-143)
-- ============================================================================
-- RLS ≠ privacidad de columnas. Las políticas de `usuarios` y `reservas` dejan
-- al miembro leer SU fila y SUS reservas, y con eso recibía columnas internas
-- del estudio. Aquí el privilegio SELECT de `authenticated` y `anon` pasa de la
-- tabla a una lista explícita de columnas:
--
--  usuarios: fuera notas_admin, sancion_motivo, acceso_autorizado_at,
--            acceso_autorizado_por (las lee el staff por
--            staff_datos_internos_cuenta; recepción ya recibía notas_admin en el
--            check-in por check_in_atomic, que es SECURITY DEFINER y no cambia).
--  reservas: fuera observaciones (staff_observaciones_reserva) y qr_token_hash
--            (identificador del servidor; solo lo usan qr-issue/qr-verify).
--
-- UPDATE/INSERT/DELETE no cambian: siguen gobernados por las políticas y por los
-- triggers (proteger_columnas_privilegiadas_usuarios, invariantes de R2-A). Las
-- funciones SECURITY DEFINER (RPC, vistas security_invoker leídas por staff con
-- columnas permitidas, triggers) no dependen de estos grants. service_role no
-- se toca.
--
-- ORDEN DE ACTIVACIÓN: esta migración se aplica DESPUÉS de desplegar el cliente
-- que ya no usa `select('*')` sobre usuarios ni reservas (un cliente viejo con
-- `*` recibiría "permission denied" al expandir las columnas revocadas).
-- ============================================================================

-- ── usuarios ─────────────────────────────────────────────────────────────────
REVOKE SELECT ON usuarios FROM authenticated, anon;
GRANT SELECT (
  id, auth_id, tenant_id, email, nombre, telefono, avatar_url, rol, status,
  membresia_tier, membresia_activa_id, trial_ends_at, commitment_ends_at,
  no_shows_count, bloqueado_hasta, created_at, updated_at, invitado,
  identidad_completa, contrato_firmado, contrato_firmado_at, sancionado_at
) ON usuarios TO authenticated, anon;

-- ── reservas ─────────────────────────────────────────────────────────────────
REVOKE SELECT ON reservas FROM authenticated, anon;
GRANT SELECT (
  id, tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio,
  status, check_in_at, check_in_by, cancelada_at, cancelada_motivo,
  invitados_count, notas, created_at, updated_at, check_in_method, cancelada_por,
  cancelacion_notificada_at, recordatorio_enviado_at, invitados_extra_pagados,
  reprogramada_desde, cancelacion_causa, cancelacion_tardia, material_requerido
) ON reservas TO authenticated, anon;
