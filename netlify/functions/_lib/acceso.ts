import type { SupabaseClient } from '@supabase/supabase-js';

/** Tipo de notificación que dispara el CambiarPasswordGate en los 3 layouts. */
export const TIPO_NOTIF_CAMBIAR_PASSWORD = 'cambiar_password';

/**
 * Deja el aviso "cambia tu contraseña temporal" al usuario al que staff le
 * creó/reseteó la clave. Best-effort: nunca rompe el alta/reset (la clave ya
 * se entregó); si falla, se loguea. Idempotente a efectos prácticos: el gate
 * toma el último aviso no leído, así que insertar dos no duplica el modal.
 */
export async function avisarCambiarPassword(
  admin: SupabaseClient,
  args: { tenant_id: string; usuario_id: string; origen: 'alta' | 'reset' }
): Promise<void> {
  try {
    const { error } = await admin.from('notificaciones').insert({
      tenant_id: args.tenant_id,
      usuario_id: args.usuario_id,
      tipo: TIPO_NOTIF_CAMBIAR_PASSWORD,
      titulo: 'Cambia tu contraseña temporal',
      mensaje:
        args.origen === 'alta'
          ? 'Entraste con la contraseña que te dieron en el estudio. Cámbiala por una tuya desde tu perfil.'
          : 'Te restablecieron la contraseña en el estudio. Cámbiala por una tuya desde tu perfil.',
      metadata: { origen: args.origen }
    });
    if (error) console.error('[avisarCambiarPassword]', error.message);
  } catch (e) {
    console.error('[avisarCambiarPassword]', e instanceof Error ? e.message : e);
  }
}
