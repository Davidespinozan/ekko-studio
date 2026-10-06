import type { Database } from '@shared/types/database';

/**
 * PKG-06D · Columnas que el CLIENTE puede leer por REST.
 *
 * La RLS decide qué filas ve cada quien; los grants por columna (migración
 * 20261014110000) deciden qué columnas. Un `select('*')` sobre `usuarios` o
 * `reservas` falla con "permission denied" porque expande columnas internas del
 * estudio (`notas_admin`, `sancion_motivo`, marcadores de 06A, `observaciones`,
 * `qr_token_hash`). Toda lectura del cliente usa estas listas; lo interno lo lee
 * el staff por RPC (`staff_datos_internos_cuenta`, `staff_observaciones_reserva`).
 */

export const COLUMNAS_USUARIO_CLIENTE =
  'id, auth_id, tenant_id, email, nombre, telefono, avatar_url, rol, status, membresia_tier, membresia_activa_id, ' +
  'trial_ends_at, commitment_ends_at, no_shows_count, bloqueado_hasta, created_at, updated_at, invitado, ' +
  'identidad_completa, contrato_firmado, contrato_firmado_at, sancionado_at';

export type UsuarioCliente = Omit<Database['public']['Tables']['usuarios']['Row'], 'notas_admin' | 'sancion_motivo'>;

export const COLUMNAS_RESERVA_CLIENTE =
  'id, tenant_id, recurso_id, usuario_id, slot_inicio, slot_fin, duracion_min, folio, status, check_in_at, check_in_by, ' +
  'cancelada_at, cancelada_motivo, invitados_count, notas, created_at, updated_at, check_in_method, cancelada_por, ' +
  'cancelacion_notificada_at, recordatorio_enviado_at, invitados_extra_pagados, reprogramada_desde, cancelacion_causa, ' +
  'cancelacion_tardia, material_requerido';

export type ReservaCliente = Omit<Database['public']['Tables']['reservas']['Row'], 'observaciones' | 'qr_token_hash'>;
