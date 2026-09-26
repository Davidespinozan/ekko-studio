import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * cron-email: despachador central de avisos por correo (solicitud del cliente,
 * punto 4). Mismo contrato que cron-push, con una diferencia a propósito: sin
 * Resend configurado NO marca nada como enviado.
 */

const mockEnviar = vi.fn();
let configurado = true;
vi.mock('../../netlify/functions/_lib/email', async (orig) => ({
  ...(await orig<typeof import('../../netlify/functions/_lib/email')>()),
  enviarEmail: (...a: unknown[]) => mockEnviar(...a),
  emailConfigurado: () => configurado
}));
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: vi.fn().mockResolvedValue(undefined) }));

let pendientes: Record<string, unknown>[] = [];
const filtros: { tipos?: string[] } = {};
const marcadas: string[] = [];
const mockFrom = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (tabla: string) => {
      mockFrom(tabla);
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'is', 'gte', 'order']) c[m] = () => c;
      c.in = (col: string, vals: string[]) => {
        if (tabla === 'notificaciones' && col === 'tipo') filtros.tipos = vals;
        if (tabla === 'usuarios') return Promise.resolve({ data: [{ id: 'u1', email: 'ana@e.mx', nombre: 'Ana López' }, { id: 'u2', email: null, nombre: 'Sin Correo' }] });
        if (tabla === 'tenants') return Promise.resolve({ data: [{ id: 't1', nombre: 'EKKO Studio', config: { landing: { footer: { direccion: 'Av. del Mar 123' } } } }] });
        return c;
      };
      c.limit = () => Promise.resolve({ data: pendientes, error: null });
      c.update = () => ({ eq: (_: string, id: string) => { marcadas.push(id); return Promise.resolve({ error: null }); } });
      return c;
    }
  }))
}));

import { handler, TIPOS_POR_CORREO } from '../../netlify/functions/cron-email/index';

const correr = async () => JSON.parse(((await handler({} as never, {} as never)) as { body: string }).body);

const confirmada = {
  id: 'n1', tenant_id: 't1', usuario_id: 'u1', tipo: 'reserva_confirmada',
  titulo: 'Reserva confirmada', mensaje: 'Tienes Set Podcast el lunes 21 de septiembre, 17:00 (60 min). Folio EKK-000123.',
  metadata: { url: '/app/qr/res-1' }
};

beforeEach(() => {
  vi.clearAllMocks();
  configurado = true;
  pendientes = [];
  marcadas.length = 0;
  process.env.VITE_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  mockEnviar.mockResolvedValue({ sent: true });
});

describe('cron-email', () => {
  it('confirmación de reserva: correo con el mismo texto del aviso, botón al QR y la dirección del estudio', async () => {
    pendientes = [confirmada];
    const r = await correr();

    expect(r).toEqual({ pendientes: 1, enviados: 1 });
    const correo = mockEnviar.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(correo.to).toBe('ana@e.mx');
    expect(correo.subject).toBe('Reserva confirmada · EKKO Studio');
    expect(correo.html).toContain('Hola Ana,');
    expect(correo.html).toContain('Set Podcast el lunes 21 de septiembre, 17:00');
    expect(correo.html).toContain('/app/qr/res-1');
    expect(correo.html).toContain('Ver mi reserva y QR');
    expect(correo.html).toContain('Dónde: Av. del Mar 123');
    expect(marcadas).toEqual(['n1']);
  });

  it('SIN Resend configurado: no consulta ni marca nada (para no perder lo reciente en silencio)', async () => {
    configurado = false;
    pendientes = [confirmada];
    const r = await correr();
    expect(r).toEqual({ skipped: 'email_no_configurado' });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(marcadas).toEqual([]);
  });

  it('usuario sin correo: no se envía, pero se marca (no se reintenta para siempre)', async () => {
    pendientes = [{ ...confirmada, id: 'n2', usuario_id: 'u2' }];
    const r = await correr();
    expect(r).toEqual({ pendientes: 1, enviados: 0 });
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(marcadas).toEqual(['n2']);
  });

  it('si el envío falla, igual se marca', async () => {
    pendientes = [confirmada];
    mockEnviar.mockRejectedValue(new Error('resend caído'));
    await correr();
    expect(marcadas).toEqual(['n1']);
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
