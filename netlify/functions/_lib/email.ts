import { optionalEnv } from './env';

/**
 * Envío de email transaccional vía Resend (HTTP API, sin SDK → sin dependencia
 * nueva). Mismo patrón que `push.ts`: si no está configurado (RESEND_API_KEY +
 * EKKO_EMAIL_FROM) es un NO-OP silencioso — el flujo principal no se rompe.
 *
 * Plug-and-play: el día que David cree la cuenta de Resend, verifique el dominio
 * ekkostudio.app y cargue las env, los emails empiezan a salir solos.
 */

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EnvioResultado {
  sent: boolean;
  skipped?: boolean; // true = no configurado (no-op)
}

const APP_URL = optionalEnv('EKKO_APP_URL', 'https://ekkostudio.app');

export async function enviarEmail(payload: EmailPayload): Promise<EnvioResultado> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  const from = optionalEnv('EKKO_EMAIL_FROM'); // ej. "EKKO Studio <hola@ekkostudio.app>"
  if (!apiKey || !from) {
    console.log('[email] no configurado (RESEND_API_KEY / EKKO_EMAIL_FROM) — no-op', { to: payload.to, subject: payload.subject });
    return { sent: false, skipped: true };
  }
  if (!payload.to) return { sent: false, skipped: true };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      // El correo es best-effort y se manda DENTRO del webhook de Stripe: un
      // Resend colgado no puede comerse el tiempo de la function (si muere a
      // medias, el reintento de Stripe choca con la idempotencia y se pierde).
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? stripHtml(payload.html)
      })
    });
    if (!res.ok) {
      console.error('[email] Resend respondió error', res.status, await res.text().catch(() => ''));
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    console.error('[email] fallo al enviar', err instanceof Error ? err.message : err);
    return { sent: false };
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pesos(centavos: number, moneda: string): string {
  const monto = Math.round(centavos / 100).toLocaleString('es-MX');
  return moneda && moneda.toUpperCase() !== 'MXN' ? `$${monto} ${moneda.toUpperCase()}` : `$${monto}`;
}

// ── Layout base ─────────────────────────────────────────────────────────────
// Email robusto (fondo claro, la mayoría de clientes lo renderizan mejor) con
// el acento mostaza de EKKO. Todo inline: los clientes de correo ignoran <style>.
function layout(opts: { estudio: string; preheader: string; cuerpo: string }): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f2;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e6e2;">
      <tr><td style="background:#0a0a0b;padding:22px 28px;">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;letter-spacing:0.04em;color:#e5b829;">${opts.estudio}</span>
      </td></tr>
      <tr><td style="padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;font-size:15px;line-height:1.6;">
        ${opts.cuerpo}
      </td></tr>
      <tr><td style="padding:18px 28px;border-top:1px solid #eee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#999;font-size:12px;line-height:1.5;">
        Este es un correo automático de ${opts.estudio}. Si tenés dudas, respondé a este mensaje.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function boton(url: string, texto: string): string {
  return `<a href="${url}" style="display:inline-block;background:#e5b829;color:#111;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px;">${texto}</a>`;
}

// ── Plantillas ──────────────────────────────────────────────────────────────

/** Pago fallido: el evento más crítico. Empuja a actualizar la tarjeta. */
export function emailPagoFallido(opts: {
  estudio: string;
  nombre: string | null;
  montoCentavos: number;
  moneda: string;
}): { subject: string; html: string } {
  const hola = opts.nombre ? `Hola ${opts.nombre.split(' ')[0]},` : 'Hola,';
  const url = `${APP_URL}/app/perfil`;
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">No pudimos procesar el cobro de tu membresía por <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong>. Tu acceso sigue activo por ahora, pero para no perderlo necesitás actualizar tu tarjeta.</p>
    <p style="margin:0 0 22px;">${boton(url, 'Actualizar mi tarjeta')}</p>
    <p style="margin:0;color:#666;font-size:13px;">Si ya lo resolviste, ignorá este correo — reintentaremos el cobro automáticamente.</p>`;
  return {
    subject: `Tu pago no se procesó — actualizá tu tarjeta`,
    html: layout({ estudio: opts.estudio, preheader: 'No pudimos procesar el cobro de tu membresía.', cuerpo })
  };
}

/** Bienvenida + recibo del primer pago (activación de la membresía). */
export function emailBienvenida(opts: {
  estudio: string;
  nombre: string | null;
  montoCentavos: number;
  moneda: string;
}): { subject: string; html: string } {
  const hola = opts.nombre ? `¡Bienvenido, ${opts.nombre.split(' ')[0]}!` : '¡Bienvenido!';
  const url = `${APP_URL}/app`;
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">Tu membresía en <strong>${opts.estudio}</strong> quedó activa. Recibimos tu pago de <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong>.</p>
    <p style="margin:0 0 22px;">Ya podés reservar tu próxima sesión desde la app.</p>
    <p style="margin:0 0 22px;">${boton(url, 'Ir a mi estudio')}</p>`;
  return {
    subject: `Tu membresía en ${opts.estudio} está activa`,
    html: layout({ estudio: opts.estudio, preheader: 'Tu membresía quedó activa. Recibimos tu pago.', cuerpo })
  };
}

/** Recibo de una renovación mensual (cobro recurrente exitoso). */
export function emailRecibo(opts: {
  estudio: string;
  nombre: string | null;
  montoCentavos: number;
  moneda: string;
}): { subject: string; html: string } {
  const hola = opts.nombre ? `Hola ${opts.nombre.split(' ')[0]},` : 'Hola,';
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 14px;">Recibimos el pago de tu membresía en <strong>${opts.estudio}</strong> por <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong>. ¡Gracias!</p>
    <p style="margin:0;color:#666;font-size:13px;">Tu acceso sigue activo. Nos vemos en el estudio.</p>`;
  return {
    subject: `Recibo de tu membresía — ${pesos(opts.montoCentavos, opts.moneda)}`,
    html: layout({ estudio: opts.estudio, preheader: 'Recibimos el pago de tu membresía.', cuerpo })
  };
}

/**
 * Confirmación de la compra de un PAQUETE de créditos (pago único). Antes no
 * salía ningún correo: los de arriba solo se mandan en `invoice.paid`, y un
 * paquete llega como `payment_intent.succeeded`. Dice lo que el miembro necesita
 * saber y no ve en ningún otro lado: cuántos créditos tiene y hasta cuándo valen.
 */
export function emailPaqueteComprado(opts: {
  estudio: string;
  nombre: string | null;
  montoCentavos: number;
  moneda: string;
  creditos: number | null;
  /** ISO; null = los créditos no caducan. */
  venceEl: string | null;
  zona?: string;
}): { subject: string; html: string } {
  const hola = opts.nombre ? `Hola ${opts.nombre.split(' ')[0]},` : 'Hola,';
  const url = `${APP_URL}/app/reservar`;
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
    <p style="margin:0 0 14px;">Recibimos tu pago de <strong>${pesos(opts.montoCentavos, opts.moneda)}</strong> en <strong>${opts.estudio}</strong>. ¡Gracias!</p>
    ${saldo}
    ${vigencia}
    <p style="margin:0 0 22px;">${boton(url, 'Reservar una sesión')}</p>`;
  return {
    subject: `Tu paquete en ${opts.estudio} está listo`,
    html: layout({ estudio: opts.estudio, preheader: 'Recibimos tu pago. Tus créditos ya están disponibles.', cuerpo })
  };
}

/**
 * ¿Está configurado el envío? (`cron-email` NO marca nada como enviado mientras
 * no lo esté: el día que se carguen las env, sale lo reciente en vez de perderse.)
 */
export function emailConfigurado(): boolean {
  return Boolean(optionalEnv('RESEND_API_KEY') && optionalEnv('EKKO_EMAIL_FROM'));
}

function escaparHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Correo genérico de un aviso de la app (`notificaciones`): mismo título y mensaje
 * que ve el miembro en la campana, con un botón a la pantalla que corresponde. Lo
 * usa `cron-email` para que TODO aviso relevante llegue por los dos canales sin
 * escribir una plantilla por tipo.
 */
export function emailAviso(opts: {
  estudio: string;
  nombre: string | null;
  titulo: string;
  mensaje: string;
  /** Ruta de la app ('/app/qr/…') o URL absoluta. */
  url?: string | null;
  botonTexto?: string;
  /** Texto extra bajo el botón (p. ej. dirección del estudio). */
  pie?: string | null;
}): { subject: string; html: string } {
  const hola = opts.nombre ? `Hola ${escaparHtml(opts.nombre.split(' ')[0])},` : 'Hola,';
  const href = opts.url ? (opts.url.startsWith('http') ? opts.url : `${APP_URL}${opts.url}`) : null;
  const cuerpo = `
    <p style="margin:0 0 14px;">${hola}</p>
    <p style="margin:0 0 8px;font-size:17px;font-weight:700;">${escaparHtml(opts.titulo)}</p>
    <p style="margin:0 0 22px;">${escaparHtml(opts.mensaje)}</p>
    ${href ? `<p style="margin:0 0 22px;">${boton(href, opts.botonTexto ?? 'Abrir en la app')}</p>` : ''}
    ${opts.pie ? `<p style="margin:0;color:#666;font-size:13px;">${escaparHtml(opts.pie)}</p>` : ''}`;
  return {
    subject: `${opts.titulo} · ${opts.estudio}`,
    // El preheader también es HTML: se escapa igual que el cuerpo (el mensaje puede
    // llevar un motivo escrito a mano por el staff).
    html: layout({ estudio: escaparHtml(opts.estudio), preheader: escaparHtml(opts.mensaje.slice(0, 120)), cuerpo })
  };
}
