import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * cron-email: despachador central de avisos por correo (solicitud del cliente,
 * punto 4). Mismo contrato que cron-push, con dos diferencias a propósito:
 *  · sin Resend configurado NO marca nada como enviado;
 *  · PKG-00F (C03): cada fila termina en un resultado VERAZ. `email_enviado_at`
 *    solo existe cuando Resend aceptó (y hay id). Un fallo o un usuario sin
 *    correo quedan como `fallo` / `sin_correo`, sin marca de envío.
 *  · PKG-03A: la toma y el resultado viven en la base (`reclamar_correos_pendientes`,
 *    `notificacion_email_resultado`); aquí se prueba qué le pide el cron a la base.
 *    Reintentos, backoff, tope y ventana se prueban contra Postgres real en
 *    src/__tests__/db/03a-pendientes-operativos.db.test.ts.
 */

const mockEnviar = vi.fn();
let configurado = true;
vi.mock('../../netlify/functions/_lib/email', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/email')>()),
  enviarEmail: (...a: unknown[]) => mockEnviar(...a),
  emailConfigurado: () => configurado
}));
const mockReportar = vi.fn().mockResolvedValue(undefined);
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => mockReportar(...a) }));

let pendientes: Record<string, unknown>[] = [];
let reclamo: { p_tipos?: string[]; p_limite?: number; p_ventana?: string } = {};
type Asiento = { p_id: string; p_resultado: string; p_proveedor_id: string | null; p_error: string | null; p_reintentable: boolean };
const marcas: Asiento[] = [];
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      mockRpc(fn, args);
      if (fn === 'reclamar_correos_pendientes') {
        reclamo = args as typeof reclamo;
        return Promise.resolve({ data: pendientes, error: null });
      }
      // notificacion_email_resultado: la base decide; aquí, su contrato mínimo.
      const a = args as unknown as Asiento;
      marcas.push(a);
      const estado = a.p_resultado === 'fallo' ? (a.p_reintentable ? 'reintentable' : 'fallo') : a.p_resultado;
      return Promise.resolve({ data: { estado, idempotente: false }, error: null });
    },
    from: (tabla: string) => {
      mockFrom(tabla);
      const c: Record<string, unknown> = {};
      for (const m of ['select']) c[m] = () => c;
      c.in = (_col: string, _vals: string[]) => {
        if (tabla === 'usuarios') return Promise.resolve({ data: [{ id: 'u1', email: 'ana@e.mx', nombre: 'Ana López' }, { id: 'u2', email: null, nombre: 'Sin Correo' }] });
        if (tabla === 'tenants') return Promise.resolve({ data: [{ id: 't1', nombre: 'EKKO Studio', branding: { logo_url_dark: 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/ekko/logo-dark.png' }, config: { landing: { footer: { direccion: 'Av. del Mar 123', email: 'hola@ekkostudio.app' } }, contacto: { whatsapp_e164: '5216671234567' } } }] });
        return c;
      };
      return c;
    }
  }))
}));

import { handler, TIPOS_POR_CORREO } from '../../netlify/functions/cron-email/index';

const correr = async () => JSON.parse(((await handler({} as never, {} as never)) as { body: string }).body);

const confirmada = {
  id: 'n1', tenant_id: 't1', usuario_id: 'u1', tipo: 'reserva_confirmada',
  titulo: 'Reserva confirmada', mensaje: 'Tienes Set Podcast el lunes 21 de septiembre, 17:00 (90 min). Folio EKK-000123.',
  metadata: { url: '/app/qr/res-1' }
};

beforeEach(() => {
  vi.clearAllMocks();
  configurado = true;
  pendientes = [];
  marcas.length = 0;
  reclamo = {};
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockEnviar.mockResolvedValue({ estado: 'aceptado', id: 're_abc' });
});

describe('cron-email', () => {
  it('Resend aceptó: correo con el texto del aviso, botón al QR, dirección y WhatsApp; asienta aceptado + id del proveedor', async () => {
    pendientes = [confirmada];
    const r = await correr();

    expect(r).toEqual({ pendientes: 1, aceptados: 1, fallidos: 0, reintentables: 0, sin_correo: 0 });
    const correo = mockEnviar.mock.calls[0][0] as { to: string; subject: string; html: string; plantilla: string; idempotencyKey: string; ref: string; timeoutMs: number };
    expect(correo.to).toBe('ana@e.mx');
    expect(correo.subject).toBe('Reserva confirmada · EKKO Studio');
    expect(correo.html).toContain('Hola Ana,');
    expect(correo.html).toContain('Set Podcast el lunes 21 de septiembre, 17:00');
    expect(correo.html).toContain('/app/qr/res-1');
    expect(correo.html).toContain('Ver mi reserva y QR');
    expect(correo.html).toContain('Dónde: Av. del Mar 123');
    // Identidad del estudio desde Administración: logo configurado (Admin → Marca), WhatsApp, correo y dirección.
    expect(correo.html).toContain('<img src="https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/ekko/logo-dark.png" alt="EKKO Studio"');
    expect(correo.html).toContain('https://wa.me/5216671234567');
    expect(correo.html).toContain('mailto:hola@ekkostudio.app');
    expect(correo.html).toMatch(/<td [^>]*>Dirección<\/td>\s*<td [^>]*>Av\. del Mar 123<\/td>/);
    expect(correo.plantilla).toBe('aviso');
    expect(correo.idempotencyKey).toBe('ekko:email:notif:n1');
    expect(correo.ref).toBe('n1');
    expect(correo.timeoutMs).toBe(8000);

    expect(marcas).toEqual([{ p_id: 'n1', p_resultado: 'aceptado', p_proveedor_id: 're_abc', p_error: null, p_reintentable: false }]);
  });

  it('la toma es de la base (reclamo con lease y ventana de 6 h), no un SELECT con filtros sueltos', async () => {
    await correr();
    expect(mockRpc).toHaveBeenCalledWith('reclamar_correos_pendientes', expect.anything());
    expect(reclamo).toMatchObject({ p_limite: 50, p_ventana: '21600 seconds' });
    expect(mockFrom).not.toHaveBeenCalledWith('notificaciones');
  });

  it('SIN Resend configurado: no consulta ni marca nada (para no perder lo reciente en silencio)', async () => {
    configurado = false;
    pendientes = [confirmada];
    const r = await correr();
    expect(r).toEqual({ skipped: 'email_no_configurado' });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(marcas).toEqual([]);
  });

  it('usuario sin correo: no se intenta; queda `sin_correo` SIN email_enviado_at', async () => {
    pendientes = [{ ...confirmada, id: 'n2', usuario_id: 'u2' }];
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, aceptados: 0, fallidos: 0, reintentables: 0, sin_correo: 1 });
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(marcas).toEqual([{ p_id: 'n2', p_resultado: 'sin_correo', p_proveedor_id: null, p_error: null, p_reintentable: false }]);
  });

  it('Resend rechaza con un 4xx permanente: fallo NO reintentable, con motivo persistible y sin id', async () => {
    pendientes = [confirmada];
    mockEnviar.mockResolvedValue({ estado: 'fallo', motivo: 'http_4xx', status: 422 });
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, aceptados: 0, fallidos: 1, reintentables: 0, sin_correo: 0 });
    expect(marcas).toEqual([{ p_id: 'n1', p_resultado: 'fallo', p_proveedor_id: null, p_error: 'http_4xx:422', p_reintentable: false }]);
  });

  it('timeout, red, 5xx y 429 son transitorios: se piden como reintentables', async () => {
    pendientes = ['n1', 'n2', 'n3', 'n4'].map((id) => ({ ...confirmada, id }));
    mockEnviar
      .mockResolvedValueOnce({ estado: 'fallo', motivo: 'timeout' })
      .mockResolvedValueOnce({ estado: 'fallo', motivo: 'red' })
      .mockResolvedValueOnce({ estado: 'fallo', motivo: 'http_5xx', status: 503 })
      .mockResolvedValueOnce({ estado: 'fallo', motivo: 'http_4xx', status: 429 });
    const r = await correr();
    expect(r).toMatchObject({ reintentables: 4, fallidos: 0 });
    expect(marcas.map((m) => [m.p_error, m.p_reintentable])).toEqual([
      ['timeout', true], ['red', true], ['http_5xx:503', true], ['http_4xx:429', true]
    ]);
  });

  it('el adapter revienta (excepción inesperada): también `fallo`, se reporta, y el lote sigue con la siguiente fila', async () => {
    pendientes = [confirmada, { ...confirmada, id: 'n3' }];
    mockEnviar.mockRejectedValueOnce(new Error('resend caído')).mockResolvedValueOnce({ estado: 'aceptado', id: 're_2' });
    const r = await correr();
    // Una excepción interna se trata como transitoria: la base decide si quedan intentos.
    expect(r).toEqual({ pendientes: 2, aceptados: 1, fallidos: 0, reintentables: 1, sin_correo: 0 });
    expect(marcas[0]).toMatchObject({ p_id: 'n1', p_resultado: 'fallo', p_error: 'error_interno', p_reintentable: true });
    expect(marcas[1]).toMatchObject({ p_id: 'n3', p_resultado: 'aceptado', p_proveedor_id: 're_2' });
    expect(mockReportar).toHaveBeenCalledWith('cron-email', expect.any(Error), expect.objectContaining({ notificacion_id: 'n1' }));
  });

  it('la key desapareció a mitad del lote (no_configurado): no se asienta nada, sin evidencia falsa (el lease vence y se retoma)', async () => {
    pendientes = [confirmada];
    mockEnviar.mockResolvedValue({ estado: 'no_configurado' });
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, aceptados: 0, fallidos: 0, reintentables: 0, sin_correo: 0 });
    expect(marcas).toEqual([]);
  });

  it('nunca pide "aceptado" sin id del proveedor', async () => {
    pendientes = [confirmada, { ...confirmada, id: 'n2', usuario_id: 'u2' }, { ...confirmada, id: 'n3' }];
    mockEnviar
      .mockResolvedValueOnce({ estado: 'fallo', motivo: 'timeout' })
      .mockResolvedValueOnce({ estado: 'aceptado', id: 're_9' });
    await correr();
    for (const m of marcas) {
      if (m.p_resultado === 'aceptado') expect(m.p_proveedor_id).toBe('re_9');
      else expect(m.p_proveedor_id).toBeNull();
    }
  });

  it('el texto del aviso se escapa: un motivo con HTML no se inyecta en el correo', async () => {
    pendientes = [{ ...confirmada, tipo: 'reserva_cancelada', titulo: 'Tu reserva fue cancelada', mensaje: 'Motivo: <img src=x onerror=alert(1)>' }];
    await correr();
    const html = (mockEnviar.mock.calls[0][0] as { html: string }).html;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('solo pide los tipos que van por correo: lo que pidió el cliente sí; recordatorios, clave y cobros (que ya tienen su correo) no', async () => {
    await correr();
    expect(reclamo.p_tipos).toEqual(Object.keys(TIPOS_POR_CORREO));
    for (const t of ['reserva_confirmada', 'reserva_cancelada', 'reserva_cancelada_por_ti', 'material_disponible']) {
      expect(reclamo.p_tipos).toContain(t);
    }
    for (const t of ['recordatorio_reserva', 'cambiar_password', 'pago_rechazado', 'cobro_rechazado']) {
      expect(reclamo.p_tipos).not.toContain(t);
    }
  });
});
