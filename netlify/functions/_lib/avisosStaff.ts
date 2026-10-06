import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarPushAUsuario, clasificarPush, registrarResultadoPush } from './push';

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
      // PKG-03A: el push sale aquí mismo; el lease evita que cron-push lo repita.
      // El resultado se asienta DESPUÉS de enviar (antes se marcaba enviado de antemano).
      push_intento_at: new Date().toISOString()
    }));
    const { data: creadas, error: insErr } = await admin.from('notificaciones').insert(filas).select('id, usuario_id');
    if (insErr) {
      console.error('[avisarStaff] insert', insErr.message);
      return 0;
    }
    const idPorUsuario = new Map(((creadas ?? []) as Array<{ id: string; usuario_id: string }>).map((c) => [c.usuario_id, c.id]));
    for (const u of staff) {
      const r = await enviarPushAUsuario(admin, u.id, {
        titulo: args.titulo,
        mensaje: args.mensaje,
        url: args.url ?? '/admin',
        tag: args.tipo
      });
      const id = idPorUsuario.get(u.id);
      if (id) await registrarResultadoPush(admin, [id], clasificarPush(r));
    }
    return staff.length;
  } catch (e) {
    console.error('[avisarStaff]', e instanceof Error ? e.message : e);
    return 0;
  }
}
