import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ERROR-UI-FIX E-06 — `backendPost`/`backendGet` deben propagar el mensaje
 * del body del error de la Netlify Function (`{ error: "..." }`), no el
 * string técnico `backendPost <path>: <status>`.
 *
 * Mock estable (vi.hoisted): `fetchWithTimeout` es un spy; `supabase` solo
 * necesita `auth.getSession` para el header (sesión nula = sin header).
 */

const h = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: null } }) } }
}));
vi.mock('@shared/lib/fetchWithTimeout', () => ({
  fetchWithTimeout: (...args: unknown[]) => h.fetchWithTimeout(...args)
}));

import { backendPost } from '../backend';

/** Respuesta falsa: backend.ts solo usa `.ok`, `.status` y `.json()`. */
function fakeRes(status: number, body: string | object | null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === null || body === '') throw new SyntaxError('Unexpected end of JSON input');
      return typeof body === 'string' ? JSON.parse(body) : body;
    }
  } as unknown as Response;
}

beforeEach(() => h.fetchWithTimeout.mockReset());

describe('backendPost · ERROR-UI-FIX E-06', () => {
  it('usa el mensaje del body {error} ante una respuesta no-OK', async () => {
    h.fetchWithTimeout.mockResolvedValue(
      fakeRes(409, { error: 'Ya existe una cuenta con ese email' })
    );
    await expect(backendPost('admin-create-user', {})).rejects.toThrow(
      'Ya existe una cuenta con ese email'
    );
  });

  it('NO expone el string técnico "backendPost <path>: <status>"', async () => {
    h.fetchWithTimeout.mockResolvedValue(fakeRes(500, { error: 'Mensaje del servidor' }));
    await expect(backendPost('x', {})).rejects.not.toThrow(/backendPost/);
  });

  it('cae a "HTTP <status>" si el body viene vacío o no es JSON', async () => {
    h.fetchWithTimeout.mockResolvedValue(fakeRes(502, ''));
    await expect(backendPost('x', {})).rejects.toThrow('HTTP 502');
  });

  it('respuesta OK → devuelve el JSON parseado', async () => {
    h.fetchWithTimeout.mockResolvedValue(fakeRes(200, { ok: true, id: 'r-1' }));
    await expect(backendPost('x', {})).resolves.toEqual({ ok: true, id: 'r-1' });
  });
});
