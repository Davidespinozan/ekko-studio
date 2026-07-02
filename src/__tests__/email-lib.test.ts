import { describe, it, expect } from 'vitest';
import {
  enviarEmail,
  emailPagoFallido,
  emailBienvenida,
  emailRecibo
} from '../../netlify/functions/_lib/email';

/**
 * Transporte de email (Resend) + plantillas transaccionales. Las plantillas son
 * puras (subject/html). El transporte se testea en su modo no-op (sin env), que
 * es el estado por defecto hasta que se conecte Resend.
 */

describe('enviarEmail (no-op sin configurar)', () => {
  it('sin RESEND_API_KEY / EKKO_EMAIL_FROM → no envía, marca skipped', async () => {
    const r = await enviarEmail({ to: 'a@b.mx', subject: 'x', html: '<p>x</p>' });
    expect(r.sent).toBe(false);
    expect(r.skipped).toBe(true);
  });
});

describe('plantillas', () => {
  const base = { estudio: 'EKKO Studio', nombre: 'David Espinoza', montoCentavos: 29900, moneda: 'mxn' };

  it('pago fallido: asunto claro + monto + link a perfil', () => {
    const t = emailPagoFallido(base);
    expect(t.subject.toLowerCase()).toContain('no se procesó');
    expect(t.html).toContain('$299'); // 29900 centavos
    expect(t.html).toContain('/app/perfil'); // CTA para actualizar tarjeta
    expect(t.html).toContain('David'); // saludo por primer nombre
  });

  it('bienvenida: nombra el estudio y confirma activación', () => {
    const t = emailBienvenida(base);
    expect(t.subject).toContain('EKKO Studio');
    expect(t.html).toContain('activa');
    expect(t.html).toContain('$299');
  });

  it('recibo: muestra el monto cobrado', () => {
    const t = emailRecibo(base);
    expect(t.subject).toContain('$299');
    expect(t.html).toContain('$299');
  });

  it('moneda != MXN se muestra con el código', () => {
    const t = emailRecibo({ ...base, moneda: 'usd', montoCentavos: 5000 });
    expect(t.html).toContain('$50 USD');
  });

  it('sin nombre → saludo genérico, no rompe', () => {
    const t = emailPagoFallido({ ...base, nombre: null });
    expect(t.html).toContain('Hola,');
  });
});
