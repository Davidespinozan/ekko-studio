import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * cron-email: despachador central de avisos por correo (solicitud del cliente,
 * punto 4). Mismo contrato que cron-push, con dos diferencias a propósito:
 *  · sin Resend configurado NO marca nada como enviado;
 *  · PKG-00F (C03): cada fila termina en un resultado VERAZ. `email_enviado_at`
 *    solo existe cuando Resend aceptó (y hay id). Un fallo o un usuario sin
 *    correo quedan como `fallo` / `sin_correo`, sin marca de envío. Las filas con
 *    resultado no se vuelven a tomar (reintentos: 02C).
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
const filtros: { tipos?: string[]; is: Array<[string, unknown]> } = { is: [] };
const marcas: Array<{ id: string; patch: Record<string, unknown> }> = [];
const mockFrom = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (tabla: string) => {
      mockFrom(tabla);
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'order']) c[m] = () => c;
      c.is = (col: string, val: unknown) => { if (tabla === 'notificaciones') filtros.is.push([col, val]); return c; };
      c.in = (col: string, vals: string[]) => {
        if (tabla === 'notificaciones' && col === 'tipo') filtros.tipos = vals;
        if (tabla === 'usuarios') return Promise.resolve({ data: [{ id: 'u1', email: 'ana@e.mx', nombre: 'Ana López' }, { id: 'u2', email: null, nombre: 'Sin Correo' }] });
        if (tabla === 'tenants') return Promise.resolve({ data: [{ id: 't1', nombre: 'EKKO Studio', branding: { logo_url_dark: 'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/logos/ekko/logo-dark.png' }, config: { landing: { footer: { direccion: 'Av. del Mar 123', email: 'hola@ekkostudio.app' } }, contacto: { whatsapp_e164: '5216671234567' } } }] });
        return c;
      };
      c.limit = () => Promise.resolve({ data: pendientes, error: null });
      c.update = (patch: Record<string, unknown>) => ({ eq: (_: string, id: string) => { marcas.push({ id, patch }); return Promise.resolve({ error: null }); } });
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
  filtros.is.length = 0;
  filtros.tipos = undefined;
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockEnviar.mockResolvedValue({ estado: 'aceptado', id: 're_abc' });
});

describe('cron-email', () => {
  it('Resend aceptó: correo con el texto del aviso, botón al QR, dirección y WhatsApp; marca aceptado + id + enviado_at', async () => {
    pendientes = [confirmada];
    const r = await correr();

    expect(r).toEqual({ pendientes: 1, aceptados: 1, fallidos: 0, sin_correo: 0 });
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

    expect(marcas).toHaveLength(1);
    expect(marcas[0].id).toBe('n1');
    expect(marcas[0].patch).toMatchObject({ email_resultado: 'aceptado', email_proveedor_id: 're_abc' });
    expect(typeof marcas[0].patch.email_enviado_at).toBe('string');
  });

  it('solo toma filas sin marca Y sin resultado: una fila con `fallo` no se reintenta aquí (02C)', async () => {
    await correr();
    expect(filtros.is).toEqual([['email_enviado_at', null], ['email_resultado', null]]);
  });

  it('SIN Resend configurado: no consulta ni marca nada (para no perder lo reciente en silencio)', async () => {
    configurado = false;
    pendientes = [confirmada];
    const r = await correr();
    expect(r).toEqual({ skipped: 'email_no_configurado' });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(marcas).toEqual([]);
  });

  it('usuario sin correo: no se intenta; queda `sin_correo` SIN email_enviado_at', async () => {
    pendientes = [{ ...confirmada, id: 'n2', usuario_id: 'u2' }];
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, aceptados: 0, fallidos: 0, sin_correo: 1 });
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(marcas).toEqual([{ id: 'n2', patch: { email_resultado: 'sin_correo' } }]);
  });

  it('Resend rechaza (fallo clasificado): queda `fallo`, SIN email_enviado_at ni id (antes se marcaba como enviado: C03)', async () => {
    pendientes = [confirmada];
    mockEnviar.mockResolvedValue({ estado: 'fallo', motivo: 'http_4xx', status: 422 });
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, aceptados: 0, fallidos: 1, sin_correo: 0 });
    expect(marcas).toEqual([{ id: 'n1', patch: { email_resultado: 'fallo' } }]);
  });

  it('el adapter revienta (excepción inesperada): también `fallo`, se reporta, y el lote sigue con la siguiente fila', async () => {
    pendientes = [confirmada, { ...confirmada, id: 'n3' }];
    mockEnviar.mockRejectedValueOnce(new Error('resend caído')).mockResolvedValueOnce({ estado: 'aceptado', id: 're_2' });
    const r = await correr();
    expect(r).toEqual({ pendientes: 2, aceptados: 1, fallidos: 1, sin_correo: 0 });
    expect(marcas[0]).toEqual({ id: 'n1', patch: { email_resultado: 'fallo' } });
    expect(marcas[1].patch).toMatchObject({ email_resultado: 'aceptado', email_proveedor_id: 're_2' });
    expect(mockReportar).toHaveBeenCalledWith('cron-email', expect.any(Error), expect.objectContaining({ notificacion_id: 'n1' }));
  });

  it('la key desapareció a mitad del lote (no_configurado): la fila queda pendiente, sin evidencia falsa', async () => {
    pendientes = [confirmada];
    mockEnviar.mockResolvedValue({ estado: 'no_configurado' });
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, aceptados: 0, fallidos: 0, sin_correo: 0 });
    expect(marcas).toEqual([]);
  });

  it('nunca marca email_enviado_at sin id del proveedor', async () => {
    pendientes = [confirmada, { ...confirmada, id: 'n2', usuario_id: 'u2' }, { ...confirmada, id: 'n3' }];
    mockEnviar
      .mockResolvedValueOnce({ estado: 'fallo', motivo: 'timeout' })
      .mockResolvedValueOnce({ estado: 'aceptado', id: 're_9' });
    await correr();
    for (const m of marcas) {
      if ('email_enviado_at' in m.patch) {
        expect(m.patch.email_resultado).toBe('aceptado');
        expect(m.patch.email_proveedor_id).toBe('re_9');
      } else {
        expect(m.patch).not.toHaveProperty('email_proveedor_id');
      }
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
    expect(filtros.tipos).toEqual(Object.keys(TIPOS_POR_CORREO));
    for (const t of ['reserva_confirmada', 'reserva_cancelada', 'reserva_cancelada_por_ti', 'material_disponible']) {
      expect(filtros.tipos).toContain(t);
    }
    for (const t of ['recordatorio_reserva', 'cambiar_password', 'pago_rechazado', 'cobro_rechazado']) {
      expect(filtros.tipos).not.toContain(t);
    }
  });
});
