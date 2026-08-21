import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarPushAUsuario } from './push';

/**
 * Aviso al EQUIPO del estudio (admins y recepción) por un evento que necesita
 * ojos humanos: cobro rechazado, reembolso, etc. Inserta una notificación por
 * persona (misma tabla que usa la campana) y manda push. Best-effort: nunca
 * rompe el flujo que lo llama. (SALA notificar_staff.)
 */
export async function avisarStaff(
  admin: SupabaseClient,
  args: { tenant_id: string; tipo: string; titulo: string; mensaje: string; metadata?: Record<string, unknown>; url?: string; soloAdmins?: boolean }
): Promise<number> {
  try {
    const roles = args.soloAdmins ? ['admin'] : ['admin', 'recepcionista'];
    const { data: staff, error } = await admin
      .from('usuarios')
      .select('id')
      .eq('tenant_id', args.tenant_id)
      .in('rol', roles)
      .eq('status', 'activo');
    if (error || !staff?.length) return 0;

    const filas = staff.map((u) => ({
      tenant_id: args.tenant_id,
      usuario_id: u.id,
      tipo: args.tipo,
      titulo: args.titulo,
      mensaje: args.mensaje,
      metadata: args.metadata ?? null,
      push_enviado_at: new Date().toISOString() // el push sale aquí mismo (no lo repite cron-push)
    }));
    const { error: insErr } = await admin.from('notificaciones').insert(filas);
    if (insErr) {
      console.error('[avisarStaff] insert', insErr.message);
      return 0;
    }
    for (const u of staff) {
      await enviarPushAUsuario(admin, u.id, {
        titulo: args.titulo,
        mensaje: args.mensaje,
        url: args.url ?? '/admin',
        tag: args.tipo
      });
    }
    return staff.length;
  } catch (e) {
    console.error('[avisarStaff]', e instanceof Error ? e.message : e);
    return 0;
  }
}
