import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PKG-06D (FR-26) · Un error interno nunca viaja crudo al navegador: el helper
 * deja la evidencia en el servidor y responde un texto fijo marcado `seguro`;
 * los errores de dominio EKKO_* y los parciales honestos (06A) se conservan.
 */

const mockReportar = vi.fn().mockResolvedValue(undefined);
vi.mock('../../netlify/functions/_lib/sentry', () => ({ reportarErrorServidor: (...a: unknown[]) => mockReportar(...a) }));

import { errorInterno, errorSeguro, MENSAJE_ERROR_INTERNO } from '../../netlify/functions/_lib/errores';
import { respuestaErrorRpc } from '../../netlify/functions/_lib/cuentas';
import { respuestaErrorAsistencia } from '../../netlify/functions/_lib/corregirAsistencia';

const body = (r: { body?: string | null }) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;

beforeEach(() => vi.clearAllMocks());

describe('errorInterno', () => {
  it('22/23/24 · un error de Postgres, de Stripe o una excepción con stack → 500 genérico, sin detalle; evidencia en el servidor', async () => {
    const pg = new Error('duplicate key value violates unique constraint "usuarios_tenant_email_lower_uniq" DETAIL: Key (lower(email))=(x) already exists');
    const r = errorInterno('reception-x', pg, undefined, { usuario_id: 'u-1' });
    expect(r.statusCode).toBe(500);
    expect(body(r)).toEqual({ error: MENSAJE_ERROR_INTERNO, codigo: 'interno', seguro: true });
    expect(r.body).not.toMatch(/duplicate|constraint|usuarios|lower\(email\)/);
    expect(mockReportar).toHaveBeenCalledWith('reception-x', pg, { usuario_id: 'u-1' });

    const stripe = Object.assign(new Error('No such customer: cus_123; request-id: req_abc'), { type: 'StripeInvalidRequestError', stack: 'at ...' });
    expect(errorInterno('stripe-y', stripe).body).not.toMatch(/cus_123|req_abc|Stripe/);
  });

  it('texto humano fijo que dice QUÉ falló (no por qué), marcado seguro', () => {
    const r = errorInterno('reception-invitados', new Error('storage: bucket quota exceeded'), 'No se pudo subir la foto. Intenta de nuevo.');
    expect(body(r)).toMatchObject({ error: 'No se pudo subir la foto. Intenta de nuevo.', seguro: true });
    expect(r.body).not.toMatch(/quota/);
    expect(body(errorSeguro('Parcial honesto', { parcial: { a: 1 } }))).toEqual({ error: 'Parcial honesto', seguro: true, parcial: { a: 1 } });
  });
});

describe('20/21/25 · los errores de dominio y los parciales sobreviven', () => {
  it('respuestaErrorRpc: EKKO_* conserva su texto y status; lo demás es genérico y seguro', async () => {
    const dom = await respuestaErrorRpc('f', { message: 'EKKO_MOTIVO_REQUERIDO: Motivo obligatorio para esta acción' });
    expect(dom.statusCode).toBe(400);
    expect(body(dom)).toEqual({ error: 'Motivo obligatorio para esta acción', codigo: 'MOTIVO_REQUERIDO' });
    const raw = await respuestaErrorRpc('f', { message: 'could not serialize access due to concurrent update' });
    expect(raw.statusCode).toBe(500);
    expect(body(raw)).toMatchObject({ codigo: 'interno', seguro: true });
    expect(raw.body).not.toMatch(/serialize/);
  });

  it('respuestaErrorAsistencia: EKKO_* mapeado; un fallo desconocido ya no sale crudo', () => {
    expect(body(respuestaErrorAsistencia('EKKO_TRANSICION_INVALIDA: De no_show no se pasa a completada'))).toMatchObject({ code: 'transicion_invalida', error: 'De no_show no se pasa a completada' });
    const r = respuestaErrorAsistencia('deadlock detected while updating reservas');
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/deadlock|reservas/);
    expect(body(r).seguro).toBe(true);
  });
});
