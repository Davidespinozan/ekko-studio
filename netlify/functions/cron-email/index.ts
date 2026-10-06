import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ok, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import { enviarEmail, emailAviso, emailConfigurado, identidadEstudio, falloReintentable, motivoPersistible } from '../_lib/email';
import { reportarErrorServidor } from '../_lib/sentry';
import { registrarEjecucion } from '../_lib/procesos';

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
 *    fallo      → no se pudo entregar la solicitud al proveedor (terminal).
 *  `email_enviado_at` significa "Resend aceptó", NUNCA "el miembro lo recibió"
 *  (PROVIDER ACCEPTED ≠ DELIVERED).
 *
 * PKG-03A · ciclo de vida en la base (la notificación ES el outbox):
 *  · `reclamar_correos_pendientes` toma la fila, cuenta el intento y le pone un
 *    lease; lo que salió de la ventana sin intentarse queda `fallo`
 *    (`ventana_vencida`), visible en Operación, en vez de perderse en silencio.
 *  · `notificacion_email_resultado` asienta el intento: transitorio con intentos
 *    restantes → `reintentable` con backoff (máx. 3); si no → terminal, con el
 *    motivo (clase + status, sin PII). La Idempotency-Key por aviso no cambia:
 *    Resend descarta el duplicado si un reintento repite algo ya aceptado.
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

type Intento =
  | { resultado: 'aceptado'; proveedorId: string }
  | { resultado: 'sin_correo' }
  | { resultado: 'fallo'; error: string; reintentable: boolean };

export const handler: Handler = async () => {
  let supabase: SupabaseClient | null = null;
  try {
    if (!emailConfigurado()) {
      // Sin proveedor no hay corrida: se asienta `omitido` (no cuenta como éxito y
      // Operación lo mostrará atrasado) si al menos hay base a la cual escribir.
      if (process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const db = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        await registrarEjecucion(db, 'cron-email', 'omitido', 'configuracion');
      }
      return ok({ skipped: 'email_no_configurado' });
    }

    supabase = createClient(requireEnv('VITE_SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase.rpc('reclamar_correos_pendientes', {
      p_tipos: Object.keys(TIPOS_POR_CORREO),
      p_limite: 50,
      p_ventana: `${VENTANA_MS / 1000} seconds`
    });
    if (error) {
      await reportarErrorServidor('cron-email', new Error(error.message), { paso: 'select' });
      await registrarEjecucion(supabase, 'cron-email', 'fallo', 'base_datos');
      return serverError(error.message);
    }

    const filas = (data ?? []) as Array<{
      id: string; tenant_id: string; usuario_id: string; tipo: string;
      titulo: string; mensaje: string; metadata: Record<string, unknown> | null;
    }>;
    if (filas.length === 0) {
      await registrarEjecucion(supabase, 'cron-email', 'exito');
      return ok({ pendientes: 0, aceptados: 0, fallidos: 0, reintentables: 0, sin_correo: 0 });
    }

    // Una consulta por tabla, no una por fila.
    const [{ data: usuarios }, { data: tenants }] = await Promise.all([
      supabase.from('usuarios').select('id, email, nombre').in('id', [...new Set(filas.map((f) => f.usuario_id))]),
      supabase.from('tenants').select('id, nombre, branding, config').in('id', [...new Set(filas.map((f) => f.tenant_id))])
    ]);
    const usuarioPorId = new Map((usuarios ?? []).map((u) => [u.id as string, u as { email: string | null; nombre: string | null }]));
    const tenantPorId = new Map((tenants ?? []).map((t) => [t.id as string, t as { nombre: string | null; branding: unknown; config: unknown }]));

    const conteo = { aceptados: 0, fallidos: 0, reintentables: 0, sin_correo: 0 };
    for (const n of filas) {
      let intento: Intento | null = null;
      try {
        const u = usuarioPorId.get(n.usuario_id);
        if (!u?.email) {
          intento = { resultado: 'sin_correo' };
        } else {
          // Identidad del estudio (logo, nombre, contacto) desde Administración.
          const estudio = identidadEstudio(tenantPorId.get(n.tenant_id));
          const tpl = emailAviso({
            estudio,
            nombre: u.nombre,
            titulo: n.titulo,
            mensaje: n.mensaje,
            url: typeof n.metadata?.url === 'string' ? n.metadata.url : '/app',
            botonTexto: TIPOS_POR_CORREO[n.tipo]?.boton,
            // La dirección solo aporta cuando hay que LLEGAR al estudio.
            pie: (n.tipo === 'reserva_confirmada' || n.tipo === 'reserva_reprogramada') && estudio.direccion ? `Dónde: ${estudio.direccion}` : null
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
            intento = { resultado: 'aceptado', proveedorId: r.id };
          } else if (r.estado === 'fallo') {
            intento = { resultado: 'fallo', error: motivoPersistible(r), reintentable: falloReintentable(r) };
          }
          // `no_configurado` (la key desapareció a mitad del lote): sin resultado; el
          // lease vence y la fila se vuelve a tomar.
        }
      } catch (e) {
        await reportarErrorServidor('cron-email', e, { notificacion_id: n.id, tipo: n.tipo });
        intento = { resultado: 'fallo', error: 'error_interno', reintentable: true };
      }
      if (!intento) continue;
      const { data: asentado, error: errMarca } = await supabase.rpc('notificacion_email_resultado', {
        p_id: n.id,
        p_resultado: intento.resultado,
        p_proveedor_id: intento.resultado === 'aceptado' ? intento.proveedorId : null,
        p_error: intento.resultado === 'fallo' ? intento.error : null,
        p_reintentable: intento.resultado === 'fallo' ? intento.reintentable : false
      });
      if (errMarca) {
        await reportarErrorServidor('cron-email', new Error(errMarca.message), { paso: 'marcar', notificacion_id: n.id });
        continue;
      }
      const estado = (asentado as { estado?: string } | null)?.estado;
      if (estado === 'aceptado') conteo.aceptados++;
      else if (estado === 'reintentable') conteo.reintentables++;
      else if (estado === 'fallo') conteo.fallidos++;
      else if (estado === 'sin_correo') conteo.sin_correo++;
    }

    console.log('[cron-email] OK', { pendientes: filas.length, ...conteo });
    // Los correos fallidos ya los muestra Operación (03A); la corrida terminó.
    await registrarEjecucion(supabase, 'cron-email', 'exito');
    return ok({ pendientes: filas.length, ...conteo });
  } catch (e) {
    await reportarErrorServidor('cron-email', e);
    await registrarEjecucion(supabase, 'cron-email', 'fallo', 'interno');
    return serverError(e instanceof Error ? e.message : 'Unknown error');
  }
};
