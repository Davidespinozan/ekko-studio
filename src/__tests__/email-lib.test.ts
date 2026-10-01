import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enviarEmail,
  emailConfigurado,
  emailPagoFallido,
  emailBienvenida,
  emailRecibo,
  emailPaqueteComprado,
  emailAviso,
  REMITENTE_EKKO,
  type EmailPayload
} from '../../netlify/functions/_lib/email';

/**
 * PKG-00F · Transporte de email (Resend por HTTP) + plantillas transaccionales.
 *
 * Contrato del transporte: NUNCA éxito sin id del proveedor; fallo clasificado;
 * `no_configurado` sin key. Idempotency-Key determinista. Sin PII en logs.
 * Las plantillas son puras y escapan todo lo que escribe un usuario o un admin.
 */

const fetchMock = vi.fn();
const logs: string[] = [];

const payload: EmailPayload = {
  to: 'ana@e.mx',
  subject: 'Reserva confirmada · EKKO Studio',
  html: '<p>Hola Ana</p>',
  plantilla: 'aviso',
  idempotencyKey: 'ekko:email:notif:n1',
  ref: 'n1'
};

function respuesta(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  logs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  process.env.RESEND_API_KEY = 're_test_SECRETO_123';
  delete process.env.EKKO_EMAIL_FROM;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.RESEND_API_KEY;
});

describe('enviarEmail · contrato veraz', () => {
  it('sin RESEND_API_KEY → no_configurado, no llama a Resend (EKKO_EMAIL_FROM ya no cuenta)', async () => {
    delete process.env.RESEND_API_KEY;
    process.env.EKKO_EMAIL_FROM = 'Alguien <x@y.mx>';
    expect(emailConfigurado()).toBe(false);
    const r = await enviarEmail(payload);
    expect(r).toEqual({ estado: 'no_configurado' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('con la key basta: emailConfigurado() es true sin EKKO_EMAIL_FROM', () => {
    expect(emailConfigurado()).toBe(true);
  });

  it('Resend 200 con id → aceptado + id del proveedor; remitente constante; Idempotency-Key determinista', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { id: 're_abc123' }));
    const r = await enviarEmail(payload);
    expect(r).toEqual({ estado: 'aceptado', id: 're_abc123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('ekko:email:notif:n1');
    expect(headers.Authorization).toBe('Bearer re_test_SECRETO_123');
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe(REMITENTE_EKKO);
    expect(REMITENTE_EKKO).toBe('EKKO Studio <notificaciones@mail.ekkostudio.app>');
    expect(body.to).toEqual(['ana@e.mx']);
    expect(body.subject).toBe(payload.subject);
    expect(body.text).toBe('Hola Ana'); // fallback de texto derivado del HTML
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('la misma notificación dos veces → la misma Idempotency-Key (determinista)', async () => {
    fetchMock.mockResolvedValue(respuesta(200, { id: 're_1' }));
    await enviarEmail(payload);
    await enviarEmail(payload);
    const llaves = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).headers as Record<string, string>).map((h) => h['Idempotency-Key']);
    expect(llaves).toEqual(['ekko:email:notif:n1', 'ekko:email:notif:n1']);
  });

  it('Resend 200 SIN id → no es aceptación: fallo (nunca éxito sin evidencia)', async () => {
    fetchMock.mockResolvedValue(respuesta(200, {}));
    const r = await enviarEmail(payload);
    expect(r).toMatchObject({ estado: 'fallo' });
  });

  it('4xx (key inválida, remitente no verificado, destinatario rechazado) → fallo http_4xx con status', async () => {
    fetchMock.mockResolvedValue(respuesta(422, { name: 'validation_error', message: 'Invalid `to` field: ana@e.mx' }));
    const r = await enviarEmail(payload);
    expect(r).toEqual({ estado: 'fallo', motivo: 'http_4xx', status: 422 });
  });

  it('5xx → fallo http_5xx con status', async () => {
    fetchMock.mockResolvedValue(respuesta(503, { message: 'unavailable' }));
    const r = await enviarEmail(payload);
    expect(r).toEqual({ estado: 'fallo', motivo: 'http_5xx', status: 503 });
  });

  it('timeout (AbortSignal.timeout) → fallo timeout', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    fetchMock.mockRejectedValue(err);
    const r = await enviarEmail(payload);
    expect(r).toEqual({ estado: 'fallo', motivo: 'timeout' });
  });

  it('caída de red → fallo red', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const r = await enviarEmail(payload);
    expect(r).toEqual({ estado: 'fallo', motivo: 'red' });
  });

  it('destinatario vacío o malformado → destinatario_invalido sin llamar a Resend', async () => {
    expect(await enviarEmail({ ...payload, to: '' })).toEqual({ estado: 'fallo', motivo: 'destinatario_invalido' });
    expect(await enviarEmail({ ...payload, to: 'no-es-un-correo' })).toEqual({ estado: 'fallo', motivo: 'destinatario_invalido' });
    expect(await enviarEmail({ ...payload, to: 'Ana <ana@e.mx>' })).toEqual({ estado: 'fallo', motivo: 'destinatario_invalido' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('timeoutMs se respeta (el cron pide más presupuesto que el webhook)', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(respuesta(200, { id: 're_1' }));
    await enviarEmail(payload);
    await enviarEmail({ ...payload, timeoutMs: 8000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([5000, 8000]);
  });

  it('logs sin PII: ref, plantilla, estado, status e id del proveedor; nunca destinatario, asunto, cuerpo ni key', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(200, { id: 're_abc123' }));
    await enviarEmail(payload);
    fetchMock.mockResolvedValueOnce(respuesta(422, { message: 'Invalid `to`: ana@e.mx' }));
    await enviarEmail(payload);
    delete process.env.RESEND_API_KEY;
    await enviarEmail(payload);

    const todo = logs.join('\n');
    expect(todo).toContain('"ref":"n1"');
    expect(todo).toContain('"plantilla":"aviso"');
    expect(todo).toContain('"estado":"aceptado"');
    expect(todo).toContain('"id":"re_abc123"');
    expect(todo).toContain('"status":422');
    expect(todo).toContain('"estado":"no_configurado"');
    expect(todo).not.toContain('ana@e.mx');
    expect(todo).not.toContain('Reserva confirmada');
    expect(todo).not.toContain('Hola Ana');
    expect(todo).not.toContain('re_test_SECRETO_123');
    expect(todo).not.toContain('Invalid');
  });
});

describe('plantillas', () => {
  const base = { estudio: 'EKKO Studio', nombre: 'David Espinoza', montoCentavos: 29900, moneda: 'mxn' };

  it('pago fallido: asunto claro + monto + link a perfil + identificador', () => {
    const t = emailPagoFallido(base);
    expect(t.plantilla).toBe('pago_fallido');
    expect(t.subject.toLowerCase()).toContain('no se procesó');
    expect(t.html).toContain('$299'); // 29900 centavos
    expect(t.html).toContain('/app/perfil'); // CTA para actualizar tarjeta
    expect(t.html).toContain('David'); // saludo por primer nombre
  });

  it('bienvenida: nombra el estudio y confirma activación', () => {
    const t = emailBienvenida(base);
    expect(t.plantilla).toBe('bienvenida');
    expect(t.subject).toContain('EKKO Studio');
    expect(t.html).toContain('activa');
    expect(t.html).toContain('$299');
  });

  it('recibo: muestra el monto cobrado', () => {
    const t = emailRecibo(base);
    expect(t.plantilla).toBe('recibo');
    expect(t.subject).toContain('$299');
    expect(t.html).toContain('$299');
  });

  it('paquete: identificador, créditos y vigencia', () => {
    const t = emailPaqueteComprado({ ...base, creditos: 12, venceEl: '2027-01-18T12:00:00Z' });
    expect(t.plantilla).toBe('paquete_comprado');
    expect(t.html).toMatch(/12 créditos/);
    expect(t.html).toMatch(/18 de enero de 2027/);
  });

  it('aviso: identificador y botón', () => {
    const t = emailAviso({ ...base, titulo: 'Reserva confirmada', mensaje: 'Lunes 17:00', url: '/app/qr/r1', botonTexto: 'Ver QR' });
    expect(t.plantilla).toBe('aviso');
    expect(t.html).toContain('https://ekkostudio.app/app/qr/r1');
    expect(t.html).toContain('Ver QR');
  });

  it('moneda != MXN se muestra con el código', () => {
    const t = emailRecibo({ ...base, moneda: 'usd', montoCentavos: 5000 });
    expect(t.html).toContain('$50 USD');
  });

  it('sin nombre → saludo genérico, no rompe', () => {
    const t = emailPagoFallido({ ...base, nombre: null });
    expect(t.html).toContain('Hola,');
    expect(emailAviso({ ...base, nombre: '   ', titulo: 't', mensaje: 'm' }).html).toContain('Hola,');
  });

  it('escapa nombre y nombre del estudio en LAS CINCO plantillas (los escribe un usuario / un admin)', () => {
    const malicioso = { ...base, nombre: '<img src=x onerror=alert(1)> Pérez', estudio: 'EKKO <script>alert(2)</script>' };
    const todas = [
      emailPagoFallido(malicioso),
      emailBienvenida(malicioso),
      emailRecibo(malicioso),
      emailPaqueteComprado({ ...malicioso, creditos: 1, venceEl: null }),
      emailAviso({ ...malicioso, titulo: '<b>t</b>', mensaje: '<i>m</i>', pie: '<u>p</u>' })
    ];
    for (const t of todas) {
      expect(t.html).not.toContain('<img');
      expect(t.html).not.toContain('<script>');
      expect(t.html).toContain('&lt;img'); // el saludo usa el primer nombre: "<img" escapado
      expect(t.html).toContain('&lt;script&gt;');
    }
    const aviso = todas[4].html;
    expect(aviso).not.toContain('<b>t</b>');
    expect(aviso).not.toContain('<i>m</i>');
    expect(aviso).not.toContain('<u>p</u>');
  });

  it('copia de EKKO (tú, no vos) y sin promesa de responder: el pie dice que no recibe respuestas', () => {
    const todas = [
      emailPagoFallido(base),
      emailBienvenida(base),
      emailRecibo(base),
      emailPaqueteComprado({ ...base, creditos: 1, venceEl: null }),
      emailAviso({ ...base, titulo: 't', mensaje: 'm' })
    ];
    for (const t of todas) {
      expect(t.html).toContain('no recibe respuestas');
      expect(t.html).not.toMatch(/respond[eé] a este/i);
      expect(t.html).not.toMatch(/\b(tenés|podés|ignorá|respondé|necesitás)\b/);
    }
    expect(todas[0].html).toContain('necesitas actualizar tu tarjeta');
    expect(todas[1].html).toContain('Ya puedes reservar');
  });

  it('con WhatsApp del estudio, el pie lo ofrece como canal (wa.me) ; sin él, solo avisa que no recibe respuestas', () => {
    const con = emailAviso({ ...base, titulo: 't', mensaje: 'm', whatsapp: '5216671234567' });
    expect(con.html).toContain('https://wa.me/5216671234567');
    expect(con.html).toContain('Escríbenos por WhatsApp');
    const sin = emailAviso({ ...base, titulo: 't', mensaje: 'm', whatsapp: null });
    expect(sin.html).not.toContain('wa.me');
    expect(sin.html).toContain('no recibe respuestas');
    // Un WhatsApp "sucio" no inyecta: solo dígitos van al enlace.
    const sucio = emailRecibo({ ...base, whatsapp: '+52 (667) 123-4567" onclick="x' });
    expect(sucio.html).toContain('https://wa.me/526671234567"');
    expect(sucio.html).not.toContain('onclick');
  });
});
