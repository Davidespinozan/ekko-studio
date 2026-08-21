import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ERROR-UI-FIX E-06 — `backendPost`/`backendGet` deben propagar el mensaje
 * del body del error de la Netlify Function (`{ error: "..." }`), no el
 * string técnico `backendPost <path>: <status>`.
 *
 * Mock estable (vi.hoisted): `fetchWithTimeout` es un spy; `supabase` solo
 * necesita `auth.getSession` para el header (sesión nula = sin header).
 */

const h = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => h.getSession(...a),
      refreshSession: (...a: unknown[]) => h.refreshSession(...a)
    }
  }
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

const AHORA_SEG = Math.floor(Date.now() / 1000);
const sesion = (token: string, expiraEnSeg: number) => ({
  data: { session: { access_token: token, expires_at: AHORA_SEG + expiraEnSeg } },
  error: null
});

beforeEach(() => {
  h.fetchWithTimeout.mockReset();
  h.getSession.mockReset();
  h.refreshSession.mockReset();
  h.getSession.mockResolvedValue({ data: { session: null } });
  h.refreshSession.mockResolvedValue({ data: { session: null }, error: null });
});

function headerEnviado(llamada = 0): string | undefined {
  const init = h.fetchWithTimeout.mock.calls[llamada]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

describe('backendPost · sesión vencida en PWA dormida (SALA ff09671 / c5deb5e)', () => {
  it('token vigente (lejos de vencer) → se manda tal cual, sin refresh', async () => {
    h.getSession.mockResolvedValue(sesion('tok-vivo', 3600));
    h.fetchWithTimeout.mockResolvedValue(fakeRes(200, { ok: true }));
    await backendPost('x', {});
    expect(h.refreshSession).not.toHaveBeenCalled();
    expect(headerEnviado()).toBe('Bearer tok-vivo');
  });

  it('token a punto de vencer (<120 s) → refresh proactivo antes de llamar', async () => {
    h.getSession.mockResolvedValue(sesion('tok-viejo', 30));
    h.refreshSession.mockResolvedValue(sesion('tok-nuevo', 3600));
    h.fetchWithTimeout.mockResolvedValue(fakeRes(200, { ok: true }));
    await backendPost('x', {});
    expect(h.refreshSession).toHaveBeenCalledTimes(1);
    expect(headerEnviado()).toBe('Bearer tok-nuevo');
  });

  it('backend responde 401 → refresca y reintenta UNA vez con el token nuevo', async () => {
    h.getSession.mockResolvedValue(sesion('tok-muerto', 3600));
    h.refreshSession.mockResolvedValue(sesion('tok-fresco', 3600));
    h.fetchWithTimeout
      .mockResolvedValueOnce(fakeRes(401, { error: 'Token inválido' }))
      .mockResolvedValueOnce(fakeRes(200, { ok: true }));
    await expect(backendPost('x', {})).resolves.toEqual({ ok: true });
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(headerEnviado(1)).toBe('Bearer tok-fresco');
  });

  it('401 y el refresh también falla → mensaje claro de sesión expirada, sin loop', async () => {
    h.getSession.mockResolvedValue(sesion('tok-muerto', 3600));
    h.refreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'refresh_token expired' } });
    h.fetchWithTimeout.mockResolvedValue(fakeRes(401, { error: 'Token inválido' }));
    await expect(backendPost('x', {})).rejects.toThrow(/Tu sesión expiró/);
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('401 persistente tras el reintento → sesión expirada (no reintenta una 3ª vez)', async () => {
    h.getSession.mockResolvedValue(sesion('tok-muerto', 3600));
    h.refreshSession.mockResolvedValue(sesion('tok-fresco', 3600));
    h.fetchWithTimeout.mockResolvedValue(fakeRes(401, { error: 'Token inválido' }));
    await expect(backendPost('x', {})).rejects.toThrow(/Tu sesión expiró/);
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(2);
  });
});

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
