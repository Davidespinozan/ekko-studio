import { supabase } from '@shared/lib/supabase';

// ============================================================================
// Soft-delete helpers (Sprint C-CRUD)
// ============================================================================
// Las entidades de dominio (recursos, tiers) usan `activo: boolean` para soft
// delete. Estos helpers encapsulan el patrón para reusarse en cualquier admin
// page que CRUDee filas con esa convención.
// ============================================================================

export type SoftDeletableTable = 'recursos' | 'tiers';

/**
 * Soft delete: setea activo=false. NO borra de BD. Reversible vía restoreRecord.
 */
export async function archiveRecord(
  table: SoftDeletableTable,
  id: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from(table)
    .update({ activo: false })
    .eq('id', id);
  return { error: error?.message ?? null };
}

/**
 * Restaurar: setea activo=true.
 */
export async function restoreRecord(
  table: SoftDeletableTable,
  id: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from(table)
    .update({ activo: true })
    .eq('id', id);
  return { error: error?.message ?? null };
}

/**
 * Genera slug único agregando sufijo -copia / -copia-N.
 * Ej:
 *   - 'pro' con [basica, pro]                 → 'pro-copia'
 *   - 'pro' con [pro, pro-copia]              → 'pro-copia-2'
 *   - 'pro' con [pro, pro-copia, pro-copia-2] → 'pro-copia-3'
 *   - 'plus' con [basica, pro]                → 'plus-copia' (siempre sufija)
 *
 * Función pura, sin side effects → fácil de testear.
 */
export function generateUniqueSlug(baseSlug: string, existingSlugs: string[]): string {
  const set = new Set(existingSlugs);
  let candidate = `${baseSlug}-copia`;
  if (!set.has(candidate)) return candidate;

  let counter = 2;
  while (set.has(`${baseSlug}-copia-${counter}`)) {
    counter++;
  }
  return `${baseSlug}-copia-${counter}`;
}

/**
 * Cuenta miembros con un tier activo.
 *
 * Hoy hay dos "fuentes de verdad" del tier de un usuario:
 *   1. `usuarios.membresia_tier` (slug) — usado por fake-signup
 *   2. `membresias` table (FK tier_id) — usado por flow Stripe futuro
 *
 * Para no romper la validación cuando todavía no hay flow Stripe real,
 * contamos por ambas vías y devolvemos el total (sin doble-conteo:
 * usamos un set de usuario_id).
 */
export async function countActiveMembersInTier(params: {
  tierId: string;
  tierSlug: string;
  tenantId: string;
}): Promise<number> {
  const [memb, users] = await Promise.all([
    supabase
      .from('membresias')
      .select('usuario_id')
      .eq('tier_id', params.tierId)
      .eq('status', 'activa'),
    supabase
      .from('usuarios')
      .select('id')
      .eq('tenant_id', params.tenantId)
      .eq('membresia_tier', params.tierSlug)
      .eq('status', 'activo')
  ]);

  if (memb.error) console.error('[countActiveMembersInTier:membresias]', memb.error);
  if (users.error) console.error('[countActiveMembersInTier:usuarios]', users.error);

  const usuarioIds = new Set<string>();
  (memb.data ?? []).forEach((row) => usuarioIds.add(row.usuario_id));
  (users.data ?? []).forEach((row) => usuarioIds.add(row.id));

  return usuarioIds.size;
}

// ============================================================================
// Hard delete helpers (Sprint D-Admin)
// ============================================================================
// El soft delete (activo=false) preserva integridad y permite recuperar.
// Estos helpers permiten un escape hatch: borrar permanentemente desde la
// papelera. SOLO se permite si no hay FKs vinculadas (validación via RPC).
// ============================================================================

export type HardDeleteCheckResult = {
  canDelete: boolean;
  reason?: string;
  count?: number;
};

export async function canHardDeleteRecurso(
  recursoId: string
): Promise<HardDeleteCheckResult> {
  const { data, error } = await supabase.rpc('count_reservas_recurso', {
    p_recurso_id: recursoId
  });

  if (error) {
    return {
      canDelete: false,
      reason: 'Error verificando reservas: ' + error.message
    };
  }

  const count = Number(data ?? 0);
  if (count > 0) {
    return {
      canDelete: false,
      reason: `Hay ${count} reserva(s) vinculadas a este estudio. No se puede eliminar permanentemente.`,
      count
    };
  }

  return { canDelete: true };
}

export async function canHardDeleteTier(
  tierId: string
): Promise<HardDeleteCheckResult> {
  const { data, error } = await supabase.rpc('count_miembros_tier', {
    p_tier_id: tierId
  });

  if (error) {
    return {
      canDelete: false,
      reason: 'Error verificando miembros: ' + error.message
    };
  }

  const count = Number(data ?? 0);
  if (count > 0) {
    return {
      canDelete: false,
      reason: `Hay ${count} miembro(s) vinculados a este plan (activos o históricos). No se puede eliminar permanentemente.`,
      count
    };
  }

  return { canDelete: true };
}

/**
 * Hard delete: borra fila de BD. IRREVERSIBLE.
 * SOLO usar después de validar con canHardDelete*.
 */
export async function hardDeleteRecord(
  table: SoftDeletableTable,
  id: string
): Promise<{ error: Error | null }> {
  const { error } = await supabase.from(table).delete().eq('id', id);
  return { error: error ? new Error(error.message) : null };
}
