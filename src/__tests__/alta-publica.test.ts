import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06C (FR-24) · `alta-publica`: registro público con correo verificado.
 * Auth, la RPC y Resend se simulan; nunca hay usuarios ni correos reales. La regla
 * de límite y clasificación vive en Postgres (db/06c-alta-publica); aquí se prueba
 * que la function: no enumera, no deja pasar nada privilegiado del body, crea la
 * cuenta SIN confirmar ni contraseña, no expone errores crudos ni el token, y usa
 * solo el origen de red que pone Netlify.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  createUser: vi.fn(),
  updateUserById: vi.fn(),
  generateLink: vi.fn(),
  enviar: vi.fn(),
  reportar: vi.fn()
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    auth: { admin: { createUser: h.createUser, updateUserById: h.updateUserById, generateLink: h.generateLink } }
  }))
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => h.reportar(...a) }));
vi.mock('../../netlify/functions/_lib/email', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/email')>()),
  enviarEmail: (...a: unknown[]) => h.enviar(...a)
}));

import { handler, MENSAJE_NEUTRO, normalizarOrigen, huella } from '../../netlify/functions/alta-publica/index';

type AnyEvent = Parameters<typeof handler>[0];
type Res = { statusCode: number; body: string; headers?: Record<string, string> };

const BODY = { nombre: '  Ana   Núñez ', email: '  Ana.Nunez@EKKO.mx ', tier: 'esencial', acepto: true };
const TOKEN = 'a'.repeat(56);

function evento(body: unknown, headers: Record<string, string> = { 'x-nf-client-connection-ip': '201.141.10.20' }, metodo = 'POST'): AnyEvent {
  return { httpMethod: metodo, headers, body: typeof body === 'string' ? body : JSON.stringify(body) } as unknown as AnyEvent;
}
const invocar = async (e: AnyEvent) => (await handler(e, {} as never, () => {})) as Res;
const cuerpo = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;
const solicitud = (data: Record<string, unknown>) => h.rpc.mockResolvedValue({ data, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-de-prueba';
  delete process.env.EKKO_APP_URL;
  solicitud({ resultado: 'ok', accion: 'crear', motivo: 'nueva', plan: 'esencial' });
  h.createUser.mockResolvedValue({ data: { user: { id: 'auth-nuevo' } }, error: null });
  h.updateUserById.mockResolvedValue({ data: {}, error: null });
  h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: TOKEN, verification_type: 'magiclink', email_otp: '123456' } }, error: null });
  h.enviar.mockResolvedValue({ estado: 'aceptado', id: 're_1' });
});

describe('alta pública · camino feliz', () => {
  it('1/9 · correo nuevo: cuenta de Auth SIN confirmar y SIN contraseña, enlace del proveedor por correo, respuesta neutra', async () => {
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(202);
    expect(cuerpo(r)).toEqual({ ok: true, mensaje: MENSAJE_NEUTRO });
    expect(h.createUser).toHaveBeenCalledTimes(1);
    const arg = h.createUser.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toEqual({
      email: 'ana.nunez@ekko.mx',
      email_confirm: false,
      user_metadata: { tenant_slug: 'ekko', nombre: 'Ana Núñez', origen: 'alta_publica', plan: 'esencial' }
    });
    expect(arg).not.toHaveProperty('password');
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'ana.nunez@ekko.mx' });
    const correo = h.enviar.mock.calls[0][0] as { to: string; html: string; plantilla: string; idempotencyKey: string; ref: string };
    expect(correo.to).toBe('ana.nunez@ekko.mx');
    expect(correo.plantilla).toBe('verificacion_correo');
    expect(correo.html).toContain(`https://ekkostudio.app/confirmar-correo?token_hash=${TOKEN}&amp;type=magiclink`);
    expect(correo.html).not.toContain('123456'); // el OTP del proveedor no viaja
    // 50 · el token solo va en el correo: ni en la llave de idempotencia, ni en la referencia, ni en la respuesta
    expect(correo.idempotencyKey).not.toContain(TOKEN);
    expect(correo.ref).not.toContain(TOKEN);
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toContain('auth-nuevo');
  });

  it('2/29–33 · el body no decide rol, estudio, status, créditos, Stripe ni contraseña: solo se leen nombre, correo, plan y acepto', async () => {
    await invocar(evento({ ...BODY, rol: 'admin', status: 'activo', tenant_slug: 'otro', tenant_id: 't', creditos: 999, stripe_customer_id: 'cus_x', membresia_activa_id: 'm', password: 'semilla123', origen: 'staff' }));
    const arg = h.createUser.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.user_metadata).toEqual({ tenant_slug: 'ekko', nombre: 'Ana Núñez', origen: 'alta_publica', plan: 'esencial' });
    expect(Object.keys(arg).sort()).toEqual(['email', 'email_confirm', 'user_metadata']);
    const rpcArgs = h.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(rpcArgs).sort()).toEqual(['p_clave_correo', 'p_clave_origen', 'p_email', 'p_tier']);
  });

  it('el plan que se guarda es el que validó la base, no el del body', async () => {
    solicitud({ resultado: 'ok', accion: 'crear', motivo: 'nueva', plan: 'premium' });
    await invocar(evento({ ...BODY, tier: 'premium' }));
    expect((h.createUser.mock.calls[0][0] as { user_metadata: { plan: string } }).user_metadata.plan).toBe('premium');
  });
});

describe('sin enumeración', () => {
  it('6/7/26 · cuenta existente, perfil con historial, perfil de staff, ambiguo, silencio y alta nueva responden IGUAL', async () => {
    const respuestas: string[] = [];
    for (const data of [
      { resultado: 'ok', accion: 'crear', motivo: 'nueva', plan: 'esencial' },
      { resultado: 'ok', accion: 'ninguna', motivo: 'cuenta_existente' },
      { resultado: 'ok', accion: 'ninguna', motivo: 'perfil_con_historial' },
      { resultado: 'ok', accion: 'ninguna', motivo: 'perfil_staff' },
      { resultado: 'ok', accion: 'ninguna', motivo: 'ambiguo' },
      { resultado: 'silencio' },
      { resultado: 'ok', accion: 'enlace', motivo: 'pendiente', auth_id: 'a1', plan: 'esencial' }
    ]) {
      solicitud(data);
      const r = await invocar(evento(BODY));
      respuestas.push(`${r.statusCode}|${r.body}`);
    }
    expect(new Set(respuestas).size).toBe(1);
  });

  it('cuenta existente / silencio: no se crea nada ni se manda correo', async () => {
    for (const data of [{ resultado: 'ok', accion: 'ninguna', motivo: 'cuenta_existente' }, { resultado: 'silencio' }]) {
      solicitud(data);
      await invocar(evento(BODY));
    }
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('22/26 · límite por origen o del estudio → 429 genérico (igual para cualquier correo), con Retry-After', async () => {
    for (const alcance of ['origen', 'global']) {
      solicitud({ resultado: 'limitado', alcance });
      const r = await invocar(evento(BODY));
      expect(r.statusCode).toBe(429);
      expect(r.headers?.['Retry-After']).toBe('600');
      expect(cuerpo(r)).toEqual({ error: 'Recibimos demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' });
      expect(r.body).not.toMatch(/origen|global|correo/i);
    }
  });
});

describe('reintentos e idempotencia', () => {
  it('8/9 · doble clic: la segunda solicitud cae en el silencio del servidor y no crea otra cuenta', async () => {
    await invocar(evento(BODY));
    solicitud({ resultado: 'silencio' });
    const r2 = await invocar(evento(BODY));
    expect(r2.statusCode).toBe(202);
    expect(h.createUser).toHaveBeenCalledTimes(1);
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it('39 · carrera: Auth dice "ya existe" → se sigue con el enlace (converge), sin error', async () => {
    h.createUser.mockResolvedValue({ data: { user: null }, error: { message: 'A user with this email address has already been registered' } });
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(202);
    expect(h.generateLink).toHaveBeenCalledTimes(1);
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it('alta pendiente: no se crea otra cuenta; la última solicitud fija nombre/plan y se manda un enlace nuevo', async () => {
    solicitud({ resultado: 'ok', accion: 'enlace', motivo: 'pendiente', auth_id: 'auth-pend', plan: 'esencial' });
    await invocar(evento(BODY));
    expect(h.createUser).not.toHaveBeenCalled();
    expect(h.updateUserById).toHaveBeenCalledWith('auth-pend', { user_metadata: { tenant_slug: 'ekko', nombre: 'Ana Núñez', origen: 'alta_publica', plan: 'esencial' } });
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it('verificado sin contraseña: enlace nuevo sin tocar la metadata', async () => {
    solicitud({ resultado: 'ok', accion: 'enlace', motivo: 'sin_contrasena', auth_id: 'auth-conf', plan: 'esencial' });
    await invocar(evento(BODY));
    expect(h.updateUserById).not.toHaveBeenCalled();
    expect(h.enviar).toHaveBeenCalledTimes(1);
  });
});

describe('errores: nunca crudos', () => {
  it('5/34/36 · error crudo de Auth al crear → 503 escrito a mano; la evidencia queda en el servidor', async () => {
    h.createUser.mockResolvedValue({ data: { user: null }, error: { message: 'Database error creating new user: relation "usuarios" violates check' } });
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(503);
    expect(cuerpo(r)).toMatchObject({ seguro: true });
    expect(r.body).not.toMatch(/Database|relation|usuarios|check/);
    expect(h.reportar).toHaveBeenCalledWith('alta-publica', expect.any(Error), { paso: 'auth.createUser' });
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('generateLink falla o no trae token → 503 seguro, sin correo', async () => {
    h.generateLink.mockResolvedValue({ data: null, error: { message: 'Email link is invalid or has expired; internal gotrue x' } });
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toMatch(/gotrue|invalid/);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('19 · el proveedor de correo no aceptó → 503 honesto ("no pudimos enviarte"), nunca "te enviamos"', async () => {
    h.enviar.mockResolvedValue({ estado: 'fallo', motivo: 'http_5xx', status: 502 });
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(503);
    expect(cuerpo(r).error).toMatch(/No pudimos enviarte el correo/);
    h.enviar.mockResolvedValue({ estado: 'no_configurado' });
    expect((await invocar(evento(BODY))).statusCode).toBe(503);
  });

  it('35 · error SQL de la RPC → 500 genérico; los de dominio conservan su texto escrito a mano', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected on relation alta_publica_intentos' } });
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/deadlock|alta_publica_intentos/);
    expect(cuerpo(r)).toMatchObject({ seguro: true });
    h.rpc.mockResolvedValue({ data: null, error: { message: 'EKKO_PLAN_NO_DISPONIBLE: Ese plan ya no está disponible. Elige otro.' } });
    const r2 = await invocar(evento(BODY));
    expect(r2.statusCode).toBe(400);
    expect(cuerpo(r2).error).toMatch(/plan ya no está disponible/);
  });

  it('una excepción inesperada → 500 genérico sin stack', async () => {
    h.rpc.mockRejectedValue(Object.assign(new Error('boom at /var/task/x.js:1'), { stack: 'Error: boom\n at x' }));
    const r = await invocar(evento(BODY));
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/boom|var\/task|stack/);
  });
});

describe('validación de la entrada', () => {
  it('método, JSON, nombre, correo, plan y aceptación de términos', async () => {
    expect((await invocar(evento(BODY, {}, 'GET'))).statusCode).toBe(405);
    expect((await invocar(evento('{no-json'))).statusCode).toBe(400);
    expect((await invocar(evento([1, 2]))).statusCode).toBe(400);
    expect((await invocar(evento({ ...BODY, nombre: 'A' }))).statusCode).toBe(400);
    expect((await invocar(evento({ ...BODY, email: 'sin-arroba' }))).statusCode).toBe(400);
    expect((await invocar(evento({ ...BODY, email: `${'a'.repeat(250)}@x.mx` }))).statusCode).toBe(400);
    expect((await invocar(evento({ ...BODY, tier: '../admin' }))).statusCode).toBe(400);
    expect((await invocar(evento({ ...BODY, tier: { hack: true } }))).statusCode).toBe(400);
    expect((await invocar(evento({ ...BODY, acepto: 'true' }))).statusCode).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('origen de red y huellas', () => {
  it('24/25 · solo la IP que pone Netlify; X-Forwarded-For (escribible por el cliente) se ignora', async () => {
    await invocar(evento(BODY, { 'x-nf-client-connection-ip': '201.141.10.20', 'x-forwarded-for': '1.2.3.4' }));
    await invocar(evento(BODY, { 'x-nf-client-connection-ip': '201.141.10.20', 'x-forwarded-for': '9.9.9.9' }));
    const [a, b] = h.rpc.mock.calls.map((c) => (c[1] as { p_clave_origen: string }).p_clave_origen);
    expect(a).toBe(b);
    expect(a).toBe(huella('service-key-de-prueba', 'origen', '201.141.10.20'));
    await invocar(evento(BODY, { 'x-forwarded-for': '1.2.3.4' }));
    expect((h.rpc.mock.calls[2][1] as { p_clave_origen: string | null }).p_clave_origen).toBeNull();
  });

  it('las huellas son HMAC hex de 64: ni el correo ni la IP viajan a la base en claro (salvo el correo para clasificar)', async () => {
    await invocar(evento(BODY));
    const args = h.rpc.mock.calls[0][1] as Record<string, string>;
    expect(args.p_clave_correo).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_clave_origen).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_clave_correo).toBe(huella('service-key-de-prueba', 'correo', 'ana.nunez@ekko.mx'));
    expect(args.p_clave_correo).not.toBe(huella('otra-llave', 'correo', 'ana.nunez@ekko.mx'));
  });

  it('normalizarOrigen: IPv4 válida, IPv6 por /64 (comprimida o no), basura → null', () => {
    expect(normalizarOrigen(' 201.141.10.20 ')).toBe('201.141.10.20');
    expect(normalizarOrigen('300.1.1.1')).toBeNull();
    expect(normalizarOrigen('2001:db8:85a3:0:1:2:3:4')).toBe('2001:db8:85a3:0::/64');
    expect(normalizarOrigen('2001:DB8:85A3::9')).toBe('2001:db8:85a3:0::/64');
    expect(normalizarOrigen('2001:0db8:85a3:0000:ffff::1')).toBe('2001:db8:85a3:0::/64');
    expect(normalizarOrigen('::1')).toBe('0:0:0:0::/64');
    expect(normalizarOrigen('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(normalizarOrigen('a::b::c')).toBeNull();
    expect(normalizarOrigen('<script>')).toBeNull();
    expect(normalizarOrigen(undefined)).toBeNull();
  });
});
