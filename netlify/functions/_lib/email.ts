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
