import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { enviarEmail, emailAviso, emailConfigurado } from '../_lib/email';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * Cron (cada 2 min): manda por CORREO los avisos de la app que lo ameritan
 * (`notificaciones.email_enviado_at IS NULL`). Mismo patrón que `cron-push`
 * (EKKO-033): un despachador central en vez de cablear un envío por disparador —
 * el aviso nace una sola vez (RPC, trigger o function) y sale por app, push y correo.
 *
 * Solicitud de cambios del cliente, punto 4: confirmación de reserva, cancelación,
 * cambios, información de la sesión y material disponible, "tanto por correo
 * electrónico como mediante la aplicación".
 *
 *  · Solo los tipos de `TIPOS_POR_CORREO`. Un recordatorio o un "cambia tu clave"
 *    se quedan en app/push; los de cobro ya tienen su propio correo en el webhook
 *    (con monto): mandarlos aquí también los duplicaría.
 *  · Sin Resend configurado NO marca nada: el día que se carguen las env sale lo
 *    reciente (ventana de 6 h) en vez de haberse perdido en silencio.
 *  · Marca la fila aunque el envío falle o el usuario no tenga correo: el aviso
 *    in-app sigue existiendo; lo que no debe pasar es reintentar para siempre.
 */
export const TIPOS_POR_CORREO: Record<string, { boton: string }> = {
  reserva_confirmada: { boton: 'Ver mi reserva y QR' },
  reserva_reprogramada: { boton: 'Ver mi nueva reserva y QR' },
  reserva_cancelada: { boton: 'Ver mis reservas' },
  reserva_cancelada_por_ti: { boton: 'Reservar otro horario' },
  membresia_pausada: { boton: 'Ver mi membresía' },
  membresia_reactivada: { boton: 'Reservar' },
  membresia_baja: { boton: 'Ver planes' },
  creditos_ajustados: { boton: 'Ver mi saldo' },
  material_disponible: { boton: 'Ver mi material' },
  aviso_manual: { boton: 'Abrir la app' }
};

const VENTANA_MS = 6 * 3600_000;

export const handler: Handler = async () => {
  try {
    if (!emailConfigurado()) {
      return ok({ skipped: 'email_no_configurado' });
    }

    const supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase
      .from('notificaciones')
      .select('id, tenant_id, usuario_id, tipo, titulo, mensaje, metadata')
      .is('email_enviado_at', null)
      .in('tipo', Object.keys(TIPOS_POR_CORREO))
      .gte('creada_at', new Date(Date.now() - VENTANA_MS).toISOString())
      .order('creada_at', { ascending: true })
      .limit(50);
    if (error) {
      await reportarErrorServidor('cron-email', new Error(error.message), { paso: 'select' });
      return serverError(error.message);
    }

    const filas = (data ?? []) as Array<{
      id: string; tenant_id: string; usuario_id: string; tipo: string;
      titulo: string; mensaje: string; metadata: Record<string, unknown> | null;
    }>;
    if (filas.length === 0) return ok({ pendientes: 0, enviados: 0 });

    // Una consulta por tabla, no una por fila.
    const [{ data: usuarios }, { data: tenants }] = await Promise.all([
      supabase.from('usuarios').select('id, email, nombre').in('id', [...new Set(filas.map((f) => f.usuario_id))]),
      supabase.from('tenants').select('id, nombre, config').in('id', [...new Set(filas.map((f) => f.tenant_id))])
    ]);
    const usuarioPorId = new Map((usuarios ?? []).map((u) => [u.id as string, u as { email: string | null; nombre: string | null }]));
    const tenantPorId = new Map((tenants ?? []).map((t) => [t.id as string, t as { nombre: string | null; config: unknown }]));

    let enviados = 0;
    for (const n of filas) {
      try {
        const u = usuarioPorId.get(n.usuario_id);
        if (u?.email) {
          const t = tenantPorId.get(n.tenant_id);
          const direccion = (t?.config as { landing?: { footer?: { direccion?: string } } } | null)?.landing?.footer?.direccion;
          const tpl = emailAviso({
            estudio: t?.nombre ?? 'EKKO Studio',
            nombre: u.nombre,
            titulo: n.titulo,
            mensaje: n.mensaje,
            url: typeof n.metadata?.url === 'string' ? n.metadata.url : '/app',
            botonTexto: TIPOS_POR_CORREO[n.tipo]?.boton,
            // La dirección solo aporta cuando hay que LLEGAR al estudio.
            pie: (n.tipo === 'reserva_confirmada' || n.tipo === 'reserva_reprogramada') && direccion ? `Dónde: ${direccion}` : null
          });
          const r = await enviarEmail({ to: u.email, subject: tpl.subject, html: tpl.html });
          if (r.sent) enviados++;
        }
      } catch (e) {
        await reportarErrorServidor('cron-email', e, { notificacion_id: n.id, tipo: n.tipo });
      } finally {
        await supabase.from('notificaciones').update({ email_enviado_at: new Date().toISOString() }).eq('id', n.id);
      }
    }

    console.log('[cron-email] OK', { pendientes: filas.length, enviados });
    return ok({ pendientes: filas.length, enviados });
  } catch (e) {
    await reportarErrorServidor('cron-email', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
