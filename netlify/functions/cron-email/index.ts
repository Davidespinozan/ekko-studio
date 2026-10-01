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
 * Cron (cada 2 min): manda por CORREO los avisos de la app que lo ameritan.
 * Mismo patrón que `cron-push` (EKKO-033): un despachador central en vez de
 * cablear un envío por disparador — el aviso nace una sola vez (RPC, trigger o
 * function) y sale por app, push y correo.
 *
 * Solicitud de cambios del cliente, punto 4: confirmación de reserva, cancelación,
 * cambios, información de la sesión y material disponible, "tanto por correo
 * electrónico como mediante la aplicación".
 *
 *  · Solo los tipos de `TIPOS_POR_CORREO`. Un recordatorio o un "cambia tu clave"
 *    se quedan en app/push; los de cobro ya tienen su propio correo en el webhook
 *    (con monto): mandarlos aquí también los duplicaría.
 *  · Sin Resend configurado NO marca nada: el día que se cargue la key sale lo
 *    reciente (ventana de 6 h) en vez de haberse perdido en silencio.
 *
 * PKG-00F · evidencia veraz (C03). Cada fila termina en UN resultado:
 *    aceptado   → Resend aceptó: email_proveedor_id + email_enviado_at.
 *    sin_correo → el usuario no tiene correo: no se intentó.
 *    fallo      → no se pudo entregar la solicitud al proveedor.
 *  `email_enviado_at` significa "Resend aceptó", NUNCA "el miembro lo recibió"
 *  (PROVIDER ACCEPTED ≠ DELIVERED). Una fila con resultado no se vuelve a
 *  tomar: aquí no hay reintentos (eso es PKG-02C, el outbox). Sin resultado y
 *  sin enviado_at = pendiente (p. ej. el cron murió a medias): se reintenta y
 *  la Idempotency-Key evita el duplicado.
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
/** El cron no comparte presupuesto con nadie: puede esperar más que el webhook. */
const TIMEOUT_MS = 8000;

type Marca =
  | { email_resultado: 'aceptado'; email_proveedor_id: string; email_enviado_at: string }
  | { email_resultado: 'sin_correo' | 'fallo' };

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
      .is('email_resultado', null)
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
    if (filas.length === 0) return ok({ pendientes: 0, aceptados: 0, fallidos: 0, sin_correo: 0 });

    // Una consulta por tabla, no una por fila.
    const [{ data: usuarios }, { data: tenants }] = await Promise.all([
      supabase.from('usuarios').select('id, email, nombre').in('id', [...new Set(filas.map((f) => f.usuario_id))]),
      supabase.from('tenants').select('id, nombre, config').in('id', [...new Set(filas.map((f) => f.tenant_id))])
    ]);
    const usuarioPorId = new Map((usuarios ?? []).map((u) => [u.id as string, u as { email: string | null; nombre: string | null }]));
    const tenantPorId = new Map((tenants ?? []).map((t) => [t.id as string, t as { nombre: string | null; config: unknown }]));

    const conteo = { aceptados: 0, fallidos: 0, sin_correo: 0 };
    for (const n of filas) {
      let marca: Marca | null = null;
      try {
        const u = usuarioPorId.get(n.usuario_id);
        if (!u?.email) {
          marca = { email_resultado: 'sin_correo' };
        } else {
          const t = tenantPorId.get(n.tenant_id);
          const cfg = t?.config as { landing?: { footer?: { direccion?: string } }; contacto?: { whatsapp_e164?: string } } | null;
          const direccion = cfg?.landing?.footer?.direccion;
          const tpl = emailAviso({
            estudio: t?.nombre ?? 'EKKO Studio',
            nombre: u.nombre,
            titulo: n.titulo,
            mensaje: n.mensaje,
            url: typeof n.metadata?.url === 'string' ? n.metadata.url : '/app',
            botonTexto: TIPOS_POR_CORREO[n.tipo]?.boton,
            // La dirección solo aporta cuando hay que LLEGAR al estudio.
            pie: (n.tipo === 'reserva_confirmada' || n.tipo === 'reserva_reprogramada') && direccion ? `Dónde: ${direccion}` : null,
            whatsapp: cfg?.contacto?.whatsapp_e164 ?? null
          });
          const r = await enviarEmail({
            to: u.email,
            subject: tpl.subject,
            html: tpl.html,
            plantilla: tpl.plantilla,
            idempotencyKey: `ekko:email:notif:${n.id}`,
            ref: n.id,
            timeoutMs: TIMEOUT_MS
          });
          if (r.estado === 'aceptado') {
            marca = { email_resultado: 'aceptado', email_proveedor_id: r.id, email_enviado_at: new Date().toISOString() };
          } else if (r.estado === 'fallo') {
            marca = { email_resultado: 'fallo' };
          }
          // `no_configurado` (la key desapareció a mitad del lote): se deja pendiente.
        }
      } catch (e) {
        await reportarErrorServidor('cron-email', e, { notificacion_id: n.id, tipo: n.tipo });
        marca = { email_resultado: 'fallo' };
      }
      if (!marca) continue;
      if (marca.email_resultado === 'aceptado') conteo.aceptados++;
      else if (marca.email_resultado === 'fallo') conteo.fallidos++;
      else conteo.sin_correo++;
      const { error: errMarca } = await supabase.from('notificaciones').update(marca).eq('id', n.id);
      if (errMarca) await reportarErrorServidor('cron-email', new Error(errMarca.message), { paso: 'marcar', notificacion_id: n.id });
    }

    console.log('[cron-email] OK', { pendientes: filas.length, ...conteo });
    return ok({ pendientes: filas.length, ...conteo });
  } catch (e) {
    await reportarErrorServidor('cron-email', e);
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
