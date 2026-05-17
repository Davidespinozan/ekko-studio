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
