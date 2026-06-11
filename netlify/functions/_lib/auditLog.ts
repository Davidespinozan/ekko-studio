import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Escritura del audit_log inmutable (Bloque A — gobernanza).
 *
 * Lo escriben las Netlify Functions de recepción/admin con el cliente
 * `service_role` (que bypassa RLS — authenticated no puede insertar).
 *
 * Reemplaza la auditoría previa en `usuarios.notas_admin` (borrable → B1/B2).
 */

export interface AuditEntry {
  tenant_id: string;
  actor_usuario_id: string | null;
  actor_rol: string | null;
  accion: string;
  target_tipo: string;
  target_id: string;
  antes?: Record<string, unknown> | null;
  despues?: Record<string, unknown> | null;
  motivo?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Inserta una entrada de auditoría. NO lanza: un fallo de auditoría no debe
 * romper la operación principal (recepción ya hizo el cambio). El fallo se
 * loguea ruidosamente para detectarlo (Sentry está pendiente — ver _lib/sentry).
 */
export async function writeAuditLog(
  supabaseAdmin: SupabaseClient,
  entry: AuditEntry
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      tenant_id: entry.tenant_id,
      actor_usuario_id: entry.actor_usuario_id,
      actor_rol: entry.actor_rol,
      accion: entry.accion,
      target_tipo: entry.target_tipo,
      target_id: entry.target_id,
      antes: entry.antes ?? null,
      despues: entry.despues ?? null,
      motivo: entry.motivo ?? null,
      metadata: entry.metadata ?? null
    });
    if (error) {
      console.error('[audit_log] write failed', { accion: entry.accion, error: error.message });
    }
  } catch (e) {
    console.error('[audit_log] write threw', {
      accion: entry.accion,
      error: e instanceof Error ? e.message : 'unknown'
    });
  }
}
