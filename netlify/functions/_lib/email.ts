import { optionalEnv } from './env';

/**
 * Envío de email transaccional vía Resend (HTTP API, sin SDK → sin dependencia
 * nueva). SOLO backend: la key vive en `RESEND_API_KEY` (Netlify) y nunca llega
 * al frontend ni a los logs.
 *
 * PKG-00F · contrato veraz:
 *   · `no_configurado`  → no hay key; no se intentó nada.
 *   · `aceptado` + id   → Resend ACEPTÓ la solicitud. NO significa entregado:
 *                         PROVIDER ACCEPTED ≠ DELIVERED (eso es 02C/02D).
 *   · `fallo` + motivo  → no se pudo entregar la solicitud al proveedor.
 * Nunca se devuelve éxito sin id del proveedor. Sin reintentos aquí: el correo
 * es un efecto secundario; quien llama decide qué registrar.
 *
 * Idempotencia: cada llamada lleva una `Idempotency-Key` determinista derivada
 * de la identidad de negocio (notificación o evento de Stripe). Resend descarta
 * el duplicado si el mismo envío se repite (cron cortado a medias, webhook
 * reprocesado).
 */

/** Remitente único de EKKO (dominio verificado en Resend, receiving apagado). */
export const REMITENTE_EKKO = 'EKKO Studio <notificaciones@mail.ekkostudio.app>';

const APP_URL = optionalEnv('EKKO_APP_URL', 'https://ekkostudio.app');
const TIMEOUT_DEFAULT_MS = 5000;

export type PlantillaEmail = 'pago_fallido' | 'bienvenida' | 'recibo' | 'paquete_comprado' | 'aviso';

export type MotivoFalloEmail = 'timeout' | 'red' | 'http_4xx' | 'http_5xx' | 'destinatario_invalido';

export type ResultadoEmail =
  | { estado: 'no_configurado' }
  | { estado: 'aceptado'; id: string }
  | { estado: 'fallo'; motivo: MotivoFalloEmail; status?: number };

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Identificador determinista de la plantilla (log + idempotencia). */
  plantilla: PlantillaEmail;
  /** `ekko:email:notif:<id>` o `ekko:email:stripe:<event>:<plantilla>`. */
  idempotencyKey: string;
  /** Referencia de negocio para el log (id de notificación / evento Stripe). Sin PII. */
  ref: string;
  /** Presupuesto de red; el webhook usa el default (01C), el cron puede dar más. */
  timeoutMs?: number;
}

/** ¿Hay proveedor? Solo la key: el remitente es constante. */
export function emailConfigurado(): boolean {
  return Boolean(optionalEnv('RESEND_API_KEY'));
}

const RE_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function enviarEmail(payload: EmailPayload): Promise<ResultadoEmail> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  if (!apiKey) {
    registrar({ ref: payload.ref, plantilla: payload.plantilla, estado: 'no_configurado' });
    return { estado: 'no_configurado' };
  }
  if (!payload.to || !RE_EMAIL.test(payload.to.trim())) {
    const r: ResultadoEmail = { estado: 'fallo', motivo: 'destinatario_invalido' };
    registrar({ ref: payload.ref, plantilla: payload.plantilla, estado: r.estado, motivo: r.motivo });
    return r;
  }

  let r: ResultadoEmail;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      // Un Resend colgado no puede comerse el tiempo de la function que lo
      // llama (en el webhook, el reintento de Stripe chocaría con el claim).
      signal: AbortSignal.timeout(payload.timeoutMs ?? TIMEOUT_DEFAULT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.idempotencyKey
      },
      body: JSON.stringify({
        from: REMITENTE_EKKO,
        to: [payload.to.trim()],
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? stripHtml(payload.html)
      })
    });
    if (res.ok) {
      const cuerpo = (await res.json().catch(() => null)) as { id?: unknown } | null;
      const id = typeof cuerpo?.id === 'string' && cuerpo.id ? cuerpo.id : null;
      // Sin id no hay evidencia de aceptación: se trata como fallo del proveedor.
      r = id ? { estado: 'aceptado', id } : { estado: 'fallo', motivo: 'http_5xx', status: res.status };
    } else {
      // Solo el status; el body de Resend puede repetir el destinatario.
      r = { estado: 'fallo', motivo: res.status >= 500 ? 'http_5xx' : 'http_4xx', status: res.status };
    }
  } catch (err) {
    const nombre = err instanceof Error ? err.name : '';
    r = { estado: 'fallo', motivo: nombre === 'TimeoutError' || nombre === 'AbortError' ? 'timeout' : 'red' };
  }
  registrar({ ref: payload.ref, plantilla: payload.plantilla, ...r });
  return r;
}

/** Log sin PII: nunca destinatario, asunto, cuerpo ni key. */
function registrar(datos: { ref: string; plantilla: PlantillaEmail; estado: string; motivo?: string; status?: number; id?: string }) {
  const linea = JSON.stringify(datos);
  if (datos.estado === 'fallo') console.error('[email]', linea);
  else console.log('[email]', linea);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function escaparHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pesos(centavos: number, moneda: string): string {
  const monto = Math.round(centavos / 100).toLocaleString('es-MX');
  return moneda && moneda.toUpperCase() !== 'MXN' ? `$${monto} ${moneda.toUpperCase()}` : `$${monto}`;
}

function primerNombre(nombre: string | null): string | null {
  const n = (nombre ?? '').trim().split(/\s+/)[0];
  return n ? escaparHtml(n) : null;
}

// ── Identidad del estudio (business-facing) ─────────────────────────────────
// El remitente técnico es siempre REMITENTE_EKKO; lo que el miembro VE (logo,
// nombre, contacto) sale de la configuración del estudio en Administración:
//   · nombre      → tenants.nombre
//   · logo        → tenants.branding.logo_url_dark → logo_url (Admin → Marca)
//                   → si no hay, el MISMO logo oficial que usa la web (BrandLogo)
//   · WhatsApp    → config.contacto.whatsapp_e164 (Admin → Contacto)
//   · dirección   → config.landing.footer.direccion (Admin → Landing)
//   · correo      → config.landing.footer.email (Admin → Landing)
// Nada se inventa: lo que no está configurado no se pinta.

/** Mismo asset que `src/shared/components/BrandLogo.tsx` (bucket público `estudios`). */
export const EKKO_LOGO_URL =
  'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png';

export interface IdentidadEstudio {
  nombre: string;
  /** URL https absoluta ya validada (nunca un path de la SPA). */
  logoUrl: string;
  /** Solo dígitos E.164, o null. */
  whatsapp: string | null;
  direccion: string | null;
  /** Correo de contacto visible (NO Reply-To), o null. */
  email: string | null;
}

/** Acepta solo URLs https absolutas; cualquier otra cosa (path relativo, javascript:, data:) se descarta. */
export function urlHttpsSegura(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Fila de `tenants` (nombre, branding, config) → identidad lista para la plantilla. */
export function identidadEstudio(t: { nombre?: unknown; branding?: unknown; config?: unknown } | null | undefined): IdentidadEstudio {
  const branding = (t?.branding ?? {}) as Record<string, unknown>;
  const cfg = (t?.config ?? {}) as { contacto?: { whatsapp_e164?: unknown }; landing?: { footer?: { direccion?: unknown; email?: unknown } } };
  const nombre = typeof t?.nombre === 'string' && t.nombre.trim() ? t.nombre.trim() : 'EKKO Studio';
  const logoUrl = urlHttpsSegura(branding.logo_url_dark) ?? urlHttpsSegura(branding.logo_url) ?? EKKO_LOGO_URL;
  const wa = typeof cfg.contacto?.whatsapp_e164 === 'string' ? cfg.contacto.whatsapp_e164.replace(/\D/g, '') : '';
  const direccion = typeof cfg.landing?.footer?.direccion === 'string' && cfg.landing.footer.direccion.trim() ? cfg.landing.footer.direccion.trim() : null;
  const emailRaw = typeof cfg.landing?.footer?.email === 'string' ? cfg.landing.footer.email.trim() : '';
  return {
    nombre,
    logoUrl,
    whatsapp: /^\d{10,15}$/.test(wa) ? wa : null,
    direccion,
    email: RE_EMAIL.test(emailRaw) ? emailRaw : null
  };
}

// ── Layout base ─────────────────────────────────────────────────────────────
// Email robusto (fondo claro, la mayoría de clientes lo renderizan mejor) con
// el acento mostaza de EKKO. Todo inline: los clientes de correo ignoran <style>.
// Cabecera: logo del estudio (URL https absoluta) + nombre. Pie: solo los
// canales de contacto configurados; nunca etiquetas vacías. `preheader` y
// `cuerpo` llegan YA escapados.
function layout(opts: { estudio: IdentidadEstudio; preheader: string; cuerpo: string }): string {
  const e = opts.estudio;
  const nombre = escaparHtml(e.nombre);
  const contactos: string[] = [];
  if (e.whatsapp) {
    contactos.push(`WhatsApp: <a href="https://wa.me/${e.whatsapp}" style="color:#666;">+${e.whatsapp}</a>`);
  }
  if (e.email) {
    contactos.push(`Correo: <a href="mailto:${escaparHtml(e.email)}" style="color:#666;">${escaparHtml(e.email)}</a>`);
  }
  if (e.direccion) {
    contactos.push(`Dirección: ${escaparHtml(e.direccion)}`);
  }
  // Receiving está apagado en Resend: no se promete respuesta a este correo.
  const pie = contactos.length
    ? `Este correo se envía automáticamente y no recibe respuestas. ¿Dudas? Contáctanos.<br>${contactos.join('<br>')}`
    : 'Este correo se envía automáticamente y no recibe respuestas.';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e6e2;">
      <tr><td align="center" style="background:#0a0a0b;padding:22px 28px;">
        <img src="${escaparHtml(e.logoUrl)}" alt="${nombre}" height="40" style="display:block;height:40px;width:auto;max-width:200px;border:0;margin:0 auto 8px;">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:700;letter-spacing:0.08em;color:#e5b829;">${nombre}</span>
      </td></tr>
      <tr><td style="padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.6;">
        ${opts.cuerpo}
      </td></tr>
      <tr><td style="padding:18px 28px;border-top:1px solid #eee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#999;font-size:12px;line-height:1.6;">
        ${pie}
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function boton(url: string, texto: string): string {
  return `<a href="${escaparHtml(url)}" style="display:inline-block;background:#e5b829;color:#111;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;">${escaparHtml(texto)}</a>`;
}

// ── Plantillas ──────────────────────────────────────────────────────────────
// Puras: devuelven { plantilla, subject, html }. Todo valor que escribe un
// usuario o un admin (nombre, nombre del estudio, mensajes, contacto) se escapa.

export interface EmailRenderizado {
  plantilla: PlantillaEmail;
  subject: string;
  html: string;
}

interface BasePago {
  estudio: IdentidadEstudio;
  nombre: string | null;
  montoCentavos: number;
  moneda: string;
}

/** Pago fallido: el evento más crítico. Empuja a actualizar la tarjeta. */
export function emailPagoFallido(opts: BasePago): EmailRenderizado {
  const n = primerNombre(opts.nombre);
  const hola = n ? `Hola ${n},` : 'Hola,';
  const url = `${APP_URL}/app/perfil`;
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">No pudimos procesar el cobro de tu membresía por <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong>. Tu acceso sigue activo por ahora, pero para no perderlo necesitas actualizar tu tarjeta.</p>
    <p style="margin:0 0 22px;">${boton(url, 'Actualizar mi tarjeta')}</p>
    <p style="margin:0;color:#666;font-size:13px;">Si ya lo resolviste, ignora este correo: reintentaremos el cobro automáticamente.</p>`;
  return {
    plantilla: 'pago_fallido',
    subject: 'Tu pago no se procesó: actualiza tu tarjeta',
    html: layout({ estudio: opts.estudio, preheader: 'No pudimos procesar el cobro de tu membresía.', cuerpo })
  };
}

/** Bienvenida + recibo del primer pago (activación de la membresía). */
export function emailBienvenida(opts: BasePago): EmailRenderizado {
  const n = primerNombre(opts.nombre);
  const hola = n ? `¡Bienvenido, ${n}!` : '¡Bienvenido!';
  const url = `${APP_URL}/app`;
  const estudio = escaparHtml(opts.estudio.nombre);
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">Tu membresía en <strong>${estudio}</strong> quedó activa. Recibimos tu pago de <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong>.</p>
    <p style="margin:0 0 22px;">Ya puedes reservar tu próxima sesión desde la app.</p>
    <p style="margin:0 0 22px;">${boton(url, 'Ir a mi estudio')}</p>`;
  return {
    plantilla: 'bienvenida',
    subject: `Tu membresía en ${opts.estudio.nombre} está activa`,
    html: layout({ estudio: opts.estudio, preheader: 'Tu membresía quedó activa. Recibimos tu pago.', cuerpo })
  };
}

/** Recibo de una renovación mensual (cobro recurrente exitoso). */
export function emailRecibo(opts: BasePago): EmailRenderizado {
  const n = primerNombre(opts.nombre);
  const hola = n ? `Hola ${n},` : 'Hola,';
  const estudio = escaparHtml(opts.estudio.nombre);
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">Recibimos el pago de tu membresía en <strong>${estudio}</strong> por <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong>. ¡Gracias!</p>
    <p style="margin:0;color:#666;font-size:13px;">Tu acceso sigue activo. Nos vemos en el estudio.</p>`;
  return {
    plantilla: 'recibo',
    subject: `Recibo de tu membresía: ${pesos(opts.montoCentavos, opts.moneda)}`,
    html: layout({ estudio: opts.estudio, preheader: 'Recibimos el pago de tu membresía.', cuerpo })
  };
}

/**
 * Confirmación de la compra de un PAQUETE de créditos (pago único). Dice lo que
 * el miembro necesita saber y no ve en ningún otro lado: cuántos créditos tiene
 * y hasta cuándo valen.
 */
export function emailPaqueteComprado(
  opts: BasePago & {
    creditos: number | null;
    /** ISO; null = los créditos no caducan. */
    venceEl: string | null;
    zona?: string;
  }
): EmailRenderizado {
  const n = primerNombre(opts.nombre);
  const hola = n ? `Hola ${n},` : 'Hola,';
  const url = `${APP_URL}/app/reservar`;
  const estudio = escaparHtml(opts.estudio.nombre);
  const saldo =
    opts.creditos === null
      ? ''
      : `<p style="margin:0 0 14px;">Tu saldo es de <strong>${opts.creditos} crédito${opts.creditos === 1 ? '' : 's'}</strong>.</p>`;
  const vigencia = opts.venceEl
    ? `<p style="margin:0 0 14px;">Úsalos antes del <strong>${new Date(opts.venceEl).toLocaleDateString('es-MX', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: opts.zona ?? 'America/Mazatlan'
      })}</strong>: ese día vencen los que no hayas usado.</p>`
    : `<p style="margin:0 0 14px;">Tus créditos no caducan.</p>`;
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">Recibimos tu pago de <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong> en <strong>${estudio}</strong>. ¡Gracias!</p>
    ${saldo}
    ${vigencia}
    <p style="margin:0 0 22px;">${boton(url, 'Reservar una sesión')}</p>`;
  return {
    plantilla: 'paquete_comprado',
    subject: `Tu paquete en ${opts.estudio.nombre} está listo`,
    html: layout({ estudio: opts.estudio, preheader: 'Recibimos tu pago. Tus créditos ya están disponibles.', cuerpo })
  };
}

/**
 * Correo genérico de un aviso de la app (`notificaciones`): mismo título y mensaje
 * que ve el miembro en la campana, con un botón a la pantalla que corresponde. Lo
 * usa `cron-email` para que TODO aviso relevante llegue por los dos canales sin
 * escribir una plantilla por tipo.
 */
export function emailAviso(opts: {
  estudio: IdentidadEstudio;
  nombre: string | null;
  titulo: string;
  mensaje: string;
  /** Ruta de la app ('/app/qr/…') o URL absoluta. */
  url?: string | null;
  botonTexto?: string;
  /** Texto extra bajo el botón (p. ej. "Dónde: <dirección>"). */
  pie?: string | null;
}): EmailRenderizado {
  const n = primerNombre(opts.nombre);
  const hola = n ? `Hola ${n},` : 'Hola,';
  const href = opts.url ? (opts.url.startsWith('http') ? opts.url : `${APP_URL}${opts.url}`) : null;
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 8px;font-size:17px;font-weight:700;">${escaparHtml(opts.titulo)}</p>
    <p style="margin:0 0 22px;">${escaparHtml(opts.mensaje)}</p>
    ${href ? `<p style="margin:0 0 22px;">${boton(href, opts.botonTexto ?? 'Abrir en la app')}</p>` : ''}
    ${opts.pie ? `<p style="margin:0;color:#666;font-size:13px;">${escaparHtml(opts.pie)}</p>` : ''}`;
  return {
    plantilla: 'aviso',
    subject: `${opts.titulo} · ${opts.estudio.nombre}`,
    // El preheader también es HTML: se escapa igual que el cuerpo (el mensaje puede
    // llevar un motivo escrito a mano por el staff).
    html: layout({ estudio: opts.estudio, preheader: escaparHtml(opts.mensaje.slice(0, 120)), cuerpo })
  };
}
