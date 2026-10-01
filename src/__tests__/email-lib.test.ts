import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enviarEmail,
  emailConfigurado,
  emailPagoFallido,
  emailBienvenida,
  emailRecibo,
  emailPaqueteComprado,
  emailAviso,
  identidadEstudio,
  urlHttpsSegura,
  REMITENTE_EKKO,
  EKKO_LOGO_URL,
  type EmailPayload,
  type IdentidadEstudio
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

describe('identidadEstudio · fuente de verdad = configuración del estudio en Administración', () => {
  it('nombre desde tenants.nombre; logo oficial de la web como fallback (URL https absoluta, misma que BrandLogo)', () => {
    const e = identidadEstudio({ nombre: 'EKKO Studio', branding: { logo_url: null }, config: {} });
    expect(e.nombre).toBe('EKKO Studio');
    expect(e.logoUrl).toBe(EKKO_LOGO_URL);
    expect(EKKO_LOGO_URL).toBe('https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png');
    expect(e.logoUrl).toMatch(/^https:\/\//);
    expect(e.whatsapp).toBeNull();
    expect(e.email).toBeNull();
    expect(e.direccion).toBeNull();
  });

  it('otro estudio: nombre y logo propios (Admin → Marca: logo_url_dark → logo_url), nunca asume EKKO', () => {
    const e = identidadEstudio({
      nombre: '  Casa Sonora  ',
      branding: { logo_url_dark: 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/casa/logo-dark.png', logo_url: 'https://x.test/claro.png' },
      config: {}
    });
    expect(e.nombre).toBe('Casa Sonora');
    expect(e.logoUrl).toBe('https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/casa/logo-dark.png');
    expect(identidadEstudio({ nombre: 'Casa', branding: { logo_url: 'https://x.test/claro.png' }, config: {} }).logoUrl).toBe('https://x.test/claro.png');
  });

  it('logo configurado inválido (path relativo de la SPA, http, javascript:, data:) → cae al logo oficial', () => {
    for (const malo of ['/assets/logo.png', 'http://inseguro.test/logo.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', '   ', 42]) {
      expect(identidadEstudio({ nombre: 'X', branding: { logo_url_dark: malo }, config: {} }).logoUrl).toBe(EKKO_LOGO_URL);
    }
    expect(urlHttpsSegura('https://ok.test/a.png')).toBe('https://ok.test/a.png');
    expect(urlHttpsSegura('ftp://no.test/a.png')).toBeNull();
  });

  it('contacto: WhatsApp (Admin → Contacto), correo y dirección (Admin → Landing) solo si están configurados y son válidos', () => {
    const e = identidadEstudio({
      nombre: 'EKKO Studio',
      branding: {},
      config: { contacto: { whatsapp_e164: '5216671234567' }, landing: { footer: { direccion: ' Av. del Mar 123 ', email: 'hola@ekkostudio.app' } } }
    });
    expect(e).toMatchObject({ whatsapp: '5216671234567', direccion: 'Av. del Mar 123', email: 'hola@ekkostudio.app' });
    const vacio = identidadEstudio({ nombre: 'EKKO Studio', branding: {}, config: { contacto: { whatsapp_e164: '' }, landing: { footer: { direccion: null, email: '' } } } });
    expect(vacio).toMatchObject({ whatsapp: null, direccion: null, email: null });
    const invalido = identidadEstudio({ nombre: 'E', branding: {}, config: { contacto: { whatsapp_e164: '12' }, landing: { footer: { email: 'no-es-correo' } } } });
    expect(invalido).toMatchObject({ whatsapp: null, email: null });
  });

  it('sin fila de tenant → identidad neutra (EKKO Studio + logo oficial), sin romper', () => {
    expect(identidadEstudio(null)).toMatchObject({ nombre: 'EKKO Studio', logoUrl: EKKO_LOGO_URL, whatsapp: null, email: null, direccion: null });
    expect(identidadEstudio(undefined).nombre).toBe('EKKO Studio');
  });
});

describe('plantillas', () => {
  const ekko: IdentidadEstudio = { nombre: 'EKKO Studio', logoUrl: EKKO_LOGO_URL, whatsapp: null, direccion: null, email: null };
  const base = { estudio: ekko, nombre: 'David Espinoza', montoCentavos: 29900, moneda: 'mxn' };
  const todas = (estudio: IdentidadEstudio, nombre: string | null = 'David Espinoza') => [
    emailPagoFallido({ ...base, estudio, nombre }),
    emailBienvenida({ ...base, estudio, nombre }),
    emailRecibo({ ...base, estudio, nombre }),
    emailPaqueteComprado({ ...base, estudio, nombre, creditos: 1, venceEl: null }),
    emailAviso({ estudio, nombre, titulo: 't', mensaje: 'm' })
  ];

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

  it('LAS CINCO: cabecera con el logo (img https absoluta, alt = nombre) y el nombre del estudio desde su configuración', () => {
    const casa: IdentidadEstudio = { ...ekko, nombre: 'Casa Sonora', logoUrl: 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/casa/logo-dark.png' };
    for (const t of todas(casa)) {
      expect(t.html).toContain('<img src="https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/casa/logo-dark.png" alt="Casa Sonora"');
      expect(t.html).toContain('>Casa Sonora</span>');
      expect(t.html).not.toContain('EKKO');
    }
    for (const t of todas(ekko)) {
      expect(t.html).toContain(`<img src="${EKKO_LOGO_URL}" alt="EKKO Studio"`);
      expect(t.html).not.toMatch(/src="\/[a-z]/); // nunca un path relativo de la SPA
      expect(t.html).not.toMatch(/<script/i);
    }
  });

  it('LAS CINCO: pie con SOLO los canales configurados; sin etiquetas vacías cuando no hay contacto', () => {
    const completo: IdentidadEstudio = { ...ekko, whatsapp: '5216671234567', email: 'hola@ekkostudio.app', direccion: 'Av. del Mar 123' };
    for (const t of todas(completo)) {
      expect(t.html).toContain('WhatsApp: <a href="https://wa.me/5216671234567"');
      expect(t.html).toContain('Correo: <a href="mailto:hola@ekkostudio.app"');
      expect(t.html).toContain('Dirección: Av. del Mar 123');
      expect(t.html).toContain('no recibe respuestas');
    }
    const soloWa: IdentidadEstudio = { ...ekko, whatsapp: '5216671234567' };
    for (const t of todas(soloWa)) {
      expect(t.html).toContain('wa.me/5216671234567');
      expect(t.html).not.toContain('Correo:');
      expect(t.html).not.toContain('Dirección:');
    }
    for (const t of todas(ekko)) {
      expect(t.html).toContain('Este correo se envía automáticamente y no recibe respuestas.');
      expect(t.html).not.toContain('WhatsApp:');
      expect(t.html).not.toContain('Correo:');
      expect(t.html).not.toContain('Dirección:');
      expect(t.html).not.toContain('Contáctanos');
      expect(t.html).not.toMatch(/null|undefined|—/);
    }
  });

  it('copia de EKKO (tú, no vos) y sin promesa de responder al correo', () => {
    for (const t of todas(ekko)) {
      expect(t.html).not.toMatch(/respond[eé] a este/i);
      expect(t.html).not.toMatch(/\b(tenés|podés|ignorá|respondé|necesitás)\b/);
    }
    expect(emailPagoFallido(base).html).toContain('necesitas actualizar tu tarjeta');
    expect(emailBienvenida(base).html).toContain('Ya puedes reservar');
  });

  it('escapa nombre del miembro y TODO lo que controla el admin (nombre del estudio, dirección, correo) en las cinco', () => {
    const malicioso: IdentidadEstudio = {
      nombre: 'EKKO <script>alert(2)</script>',
      logoUrl: 'https://ok.test/logo.png" onerror="alert(3)',
      whatsapp: '5216671234567',
      direccion: 'Calle <b>1</b>',
      email: 'a@b.mx'
    };
    for (const t of todas(malicioso, '<img src=x onerror=alert(1)> Pérez')) {
      expect(t.html).not.toContain('<img src=x');
      expect(t.html).not.toContain('<script>');
      expect(t.html).not.toContain('<b>1</b>');
      expect(t.html).not.toContain('onerror="alert(3)"');
      expect(t.html).toContain('&lt;img'); // el saludo usa el primer nombre: "<img" escapado
      expect(t.html).toContain('&lt;script&gt;');
      expect(t.html).toContain('&quot; onerror=&quot;alert(3)'); // la comilla no cierra el atributo src
    }
    const aviso = emailAviso({ estudio: ekko, nombre: 'Ana', titulo: '<b>t</b>', mensaje: '<i>m</i>', pie: '<u>p</u>' }).html;
    expect(aviso).not.toContain('<b>t</b>');
    expect(aviso).not.toContain('<i>m</i>');
    expect(aviso).not.toContain('<u>p</u>');
  });

  it('un WhatsApp "sucio" no llega a la plantilla (identidadEstudio lo normaliza) y el enlace solo lleva dígitos', () => {
    const e = identidadEstudio({ nombre: 'E', branding: {}, config: { contacto: { whatsapp_e164: '+52 (667) 123-4567" onclick="x' } } });
    expect(e.whatsapp).toBe('526671234567');
    const html = emailRecibo({ ...base, estudio: e }).html;
    expect(html).toContain('https://wa.me/526671234567"');
    expect(html).not.toContain('onclick');
  });
});
