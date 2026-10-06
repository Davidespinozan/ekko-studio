import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22 no hay
// WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac } from 'node:crypto';
import { requireEnv, optionalEnv } from '../_lib/env';
import { enviarEmail, escaparHtml } from '../_lib/email';
import { errorInterno } from '../_lib/errores';
import { codigoRpc, esCorreoYaRegistrado } from '../_lib/cuentas';
import { reportarErrorServidor } from '../_lib/sentry';

/**
 * POST /alta-publica — registro público de un miembro (PKG-06C · FR-24 · EKKO-146).
 * Body: { nombre, email, tier: <slug de un plan en venta>, acepto: true }.
 *
 * Escribir un correo no prueba que sea tuyo. Por eso:
 *  1. `alta_publica_solicitar` (service_role, UNA transacción) aplica el límite de
 *     tasa durable (huellas HMAC del correo y del origen de red, nunca en claro),
 *     valida el plan y clasifica el correo con el estado real.
 *  2. Si procede, se crea la cuenta de Auth SIN confirmar y SIN contraseña
 *     (`email_confirm: false`): no puede iniciar sesión y el trigger no le da
 *     identidad EKKO. El proveedor genera el token de verificación
 *     (`generateLink`, que no envía nada) y EKKO manda el enlace por su remitente
 *     verificado (Resend); el token no se guarda en ninguna tabla.
 *  3. El dueño del buzón abre el enlace → el proveedor confirma el correo → el
 *     trigger crea el perfil `miembro` / `pendiente_pago` (o vincula el perfil
 *     elegible, reglas de 06A) → la app le pide su contraseña. La contraseña la fija
 *     quien controla el buzón, después de probarlo: nadie puede dejar "sembrada"
 *     una contraseña en la cuenta de otro.
 *
 * La respuesta es la misma exista o no la cuenta (sin enumeración). El rol, el
 * estudio, el plan pagado, los créditos y la membresía nunca salen del body.
 */

export const MENSAJE_NEUTRO =
  'Si el correo puede usarse para una cuenta nueva, te enviamos un enlace para confirmarlo. Revisa tu bandeja de entrada y la carpeta de spam. Si ya tienes cuenta, inicia sesión.';
const MENSAJE_LIMITE = 'Recibimos demasiadas solicitudes. Espera unos minutos e intenta de nuevo.';
const MENSAJE_NO_ENVIADO =
  'No pudimos enviarte el correo de confirmación en este momento. Intenta de nuevo en un par de minutos.';
const MENSAJE_INTERNO = 'No pudimos procesar tu registro. Intenta de nuevo en unos minutos.';

const RE_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const RE_TIER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Tipos de enlace que la pantalla de confirmación acepta (los del proveedor). */
const TIPOS_ENLACE = new Set(['magiclink', 'signup', 'invite', 'email']);

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function responder(statusCode: number, cuerpo: Record<string, unknown>, extra: Record<string, string> = {}): HandlerResponse {
  return { statusCode, headers: { ...HEADERS, ...extra }, body: JSON.stringify(cuerpo) };
}
const neutra = () => responder(202, { ok: true, mensaje: MENSAJE_NEUTRO });

/**
 * Origen de red para el límite. Solo `x-nf-client-connection-ip`, que pone el
 * borde de Netlify con la IP de la conexión real; `x-forwarded-for` lo puede
 * escribir el cliente y se ignora. IPv6 se agrupa por /64 (un mismo cliente
 * controla todo su /64). Sin cabecera válida no hay límite por origen (sí por
 * correo y el techo del estudio).
 */
export function normalizarOrigen(valor: string | undefined | null): string | null {
  const ip = (valor ?? '').trim().toLowerCase();
  if (!ip) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((o) => Number(o) <= 255) ? ip : null;
  }
  if (!/^[0-9a-f:]+$/.test(ip) || !ip.includes(':')) return null;
  const partes = ip.split('::');
  if (partes.length > 2) return null;
  const izq = partes[0] ? partes[0].split(':') : [];
  const der = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const faltan = 8 - izq.length - der.length;
  if (faltan < 0 || (partes.length === 1 && faltan !== 0)) return null;
  const grupos = [...izq, ...Array(faltan).fill('0'), ...der];
  if (grupos.some((g) => g.length === 0 || g.length > 4)) return null;
  return grupos.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

/** Huella HMAC: la base guarda esto, nunca el correo ni la IP. */
export function huella(llave: string, tipo: 'correo' | 'origen', valor: string): string {
  return createHmac('sha256', llave).update(`ekko:alta_publica:${tipo}:${valor}`).digest('hex');
}

interface Solicitud {
  resultado: 'ok' | 'limitado' | 'silencio';
  accion?: 'crear' | 'enlace' | 'ninguna';
  motivo?: string;
  auth_id?: string;
  plan?: string;
}

function correoDeConfirmacion(nombre: string, enlace: string): { subject: string; html: string } {
  const n = escaparHtml(nombre);
  const href = escaparHtml(enlace);
  return {
    subject: 'Confirma tu correo para entrar a EKKO Studio',
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#111">
<h2 style="margin:0 0 12px">Hola, ${n}</h2>
<p style="line-height:1.55;margin:0 0 16px">Para terminar tu registro en EKKO Studio confirma que este correo es tuyo. Después eliges tu contraseña.</p>
<p style="margin:0 0 20px"><a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Confirmar mi correo</a></p>
<p style="line-height:1.55;margin:0 0 8px;font-size:13px;color:#555">El enlace vence en 1 hora y solo funciona una vez. Si vence, vuelve a registrarte para recibir otro.</p>
<p style="line-height:1.55;margin:0;font-size:13px;color:#555">Si tú no pediste esta cuenta, ignora este correo: sin confirmarlo no se crea nada a tu nombre.</p>
</div>`
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return responder(405, { error: 'Method not allowed' });

  let cuerpo: Record<string, unknown>;
  try {
    const parsed = JSON.parse(event.body || '{}');
    cuerpo = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return responder(400, { error: 'Solicitud inválida.' });
  }

  // Solo estos cuatro campos se leen; rol, estudio, créditos, status, ids de
  // Stripe o cualquier otra cosa del body se ignoran por construcción.
  const nombre = typeof cuerpo.nombre === 'string' ? cuerpo.nombre.trim().replace(/\s+/g, ' ') : '';
  const email = typeof cuerpo.email === 'string' ? cuerpo.email.trim().toLowerCase() : '';
  const tier = typeof cuerpo.tier === 'string' ? cuerpo.tier.trim() : '';

  if (nombre.length < 2 || nombre.length > 120) return responder(400, { error: 'Ingresa tu nombre completo.' });
  if (!email || email.length > 254 || !RE_EMAIL.test(email)) return responder(400, { error: 'Ingresa un correo válido.' });
  if (!RE_TIER.test(tier)) return responder(400, { error: 'Elige un plan válido desde la página principal.' });
  if (cuerpo.acepto !== true) {
    return responder(400, { error: 'Debes aceptar los términos y el aviso de privacidad para continuar.' });
  }

  try {
    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const origen = normalizarOrigen(event.headers['x-nf-client-connection-ip']);
    const { data, error } = await admin.rpc('alta_publica_solicitar', {
      p_email: email,
      p_clave_correo: huella(serviceKey, 'correo', email),
      p_clave_origen: origen ? huella(serviceKey, 'origen', origen) : null,
      p_tier: tier
    });
    if (error) {
      const { codigo, texto } = codigoRpc(error.message);
      if (codigo === 'PLAN_NO_DISPONIBLE') return responder(400, { error: 'Ese plan ya no está disponible. Elige otro desde la página principal.' });
      if (codigo === 'CORREO_INVALIDO') return responder(400, { error: texto || 'Ingresa un correo válido.' });
      return errorInterno('alta-publica', error, MENSAJE_INTERNO, { paso: 'solicitar' });
    }

    const s = (data ?? {}) as Solicitud;
    // Diagnóstico del servidor: clase, sin correo ni IP.
    console.log('[alta-publica]', JSON.stringify({ resultado: s.resultado, accion: s.accion ?? null, motivo: s.motivo ?? null }));

    if (s.resultado === 'limitado') return responder(429, { error: MENSAJE_LIMITE }, { 'Retry-After': '600' });
    if (s.resultado !== 'ok' || s.accion === 'ninguna' || !s.accion) return neutra();

    const metadata = { tenant_slug: 'ekko', nombre, origen: 'alta_publica', plan: s.plan ?? tier };

    if (s.accion === 'crear') {
      // Sin contraseña y sin confirmar: no hay sesión posible hasta probar el buzón.
      const creado = await admin.auth.admin.createUser({ email, email_confirm: false, user_metadata: metadata });
      if (creado.error && !esCorreoYaRegistrado(creado.error.message)) {
        await reportarErrorServidor('alta-publica', new Error(creado.error.message), { paso: 'auth.createUser' });
        return responder(503, { error: MENSAJE_NO_ENVIADO, seguro: true });
      }
      // "Ya existe" = otra solicitud ganó la carrera: se sigue con el enlace.
    } else if (s.motivo === 'pendiente' && s.auth_id) {
      // Alta pendiente: la última solicitud fija nombre y plan. Es cosmético (el
      // plan se revalida al confirmar); si falla, el enlace sigue sirviendo.
      const act = await admin.auth.admin.updateUserById(s.auth_id, { user_metadata: metadata });
      if (act.error) await reportarErrorServidor('alta-publica', new Error(act.error.message), { paso: 'auth.updateUser' });
    }

    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const props = link.data?.properties as { hashed_token?: string; verification_type?: string } | undefined;
    const token = props?.hashed_token;
    const tipo = props?.verification_type && TIPOS_ENLACE.has(props.verification_type) ? props.verification_type : 'magiclink';
    if (link.error || !token) {
      await reportarErrorServidor('alta-publica', new Error(link.error?.message ?? 'sin token'), { paso: 'auth.generateLink' });
      return responder(503, { error: MENSAJE_NO_ENVIADO, seguro: true });
    }

    const appUrl = optionalEnv('EKKO_APP_URL', 'https://ekkostudio.app').replace(/\/+$/, '');
    const enlace = `${appUrl}/confirmar-correo?token_hash=${encodeURIComponent(token)}&type=${encodeURIComponent(tipo)}`;
    const ref = createHash('sha256').update(token).digest('hex');
    const { subject, html } = correoDeConfirmacion(nombre, enlace);
    const envio = await enviarEmail({
      to: email,
      subject,
      html,
      plantilla: 'verificacion_correo',
      idempotencyKey: `ekko:email:alta:${ref}`,
      ref: `alta:${ref.slice(0, 16)}`
    });
    if (envio.estado !== 'aceptado') {
      // PROVIDER ACCEPTED ≠ DELIVERED, pero sin aceptación no se dice "enviado".
      return responder(503, { error: MENSAJE_NO_ENVIADO, seguro: true });
    }
    return neutra();
  } catch (err) {
    return errorInterno('alta-publica', err, MENSAJE_INTERNO);
  }
};
