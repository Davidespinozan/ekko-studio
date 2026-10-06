import { supabase } from './supabase';
import { fetchWithTimeout } from './fetchWithTimeout';

const FUNCTIONS_BASE = '/.netlify/functions';

/** Lo único que ve el usuario ante un 5xx sin texto marcado como seguro. */
export const MENSAJE_ERROR_SERVIDOR = 'No se pudo completar la operación. Intenta de nuevo.';

/** Margen (s) antes de que venza el access_token para refrescarlo proactivamente. */
const MARGEN_REFRESH_SEG = 120;

async function getAuthHeader(): Promise<Record<string, string>> {
  let { data: { session } } = await supabase.auth.getSession();

  // En una PWA (iPad de recepción, escritorio del admin) que queda abierta o
  // suspendida horas, el access_token puede venir vencido o a punto: getSession
  // no siempre lo refresca a tiempo y mandar un token muerto = "Token inválido"
  // en el backend. Si está por expirar, forzamos un refresh para que la sesión se
  // auto-cure sin que el usuario vuelva a loguearse. (Portado de SALA ff09671.)
  const ahoraSeg = Math.floor(Date.now() / 1000);
  if (session && (session.expires_at ?? 0) - ahoraSeg < MARGEN_REFRESH_SEG) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) session = data.session;
  }

  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Fuerza un refresh y devuelve el header con el token nuevo (o vacío si el
 * refresh falló, p. ej. el refresh_token también venció). Se usa para REINTENTAR
 * cuando el backend respondió 401. (Portado de SALA c5deb5e.)
 */
async function refrescarHeader(): Promise<Record<string, string>> {
  const { data, error } = await supabase.auth.refreshSession();
  if (!error && data.session?.access_token) {
    return { Authorization: `Bearer ${data.session.access_token}` };
  }
  return {};
}

/**
 * Construye un Error a partir de una respuesta no-OK (ERROR-UI-FIX E-06).
 *
 * Las Netlify Functions devuelven `{ error: "mensaje en español" }`; se usa ese
 * mensaje. Si el body viene vacío o no es JSON, se cae a `HTTP <status>`. Un
 * 401 que sobrevivió al reintento = la sesión de verdad expiró → mensaje claro.
 */
async function errorDeRespuesta(res: Response, path: string): Promise<Error> {
  let mensaje = res.status >= 500 ? MENSAJE_ERROR_SERVIDOR : `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown; seguro?: unknown };
    // PKG-06D (FR-26): un 4xx trae texto de dominio/validación escrito a mano y
    // se muestra. Un 5xx solo se muestra si el servidor marcó el texto como
    // `seguro` (escrito a mano: parcial honesto, "no se pudo subir la foto");
    // cualquier otro 5xx se enmascara, aunque el servidor haya filtrado un
    // mensaje técnico. Defensa en profundidad: la frontera real es el servidor.
    if (typeof body?.error === 'string' && body.error.trim() && (res.status < 500 || body.seguro === true)) {
      mensaje = body.error;
    }
  } catch {
    // body vacío o no-JSON → queda el fallback `HTTP <status>`.
  }
  if (res.status === 401) {
    mensaje = 'Tu sesión expiró. Cierra sesión y vuelve a entrar.';
  }
  const err = new Error(mensaje) as Error & { status?: number; path?: string };
  err.status = res.status;
  err.path = path;
  return err;
}

/** Manda la request; si el backend responde 401, refresca el token y reintenta UNA vez. */
async function conReintento401(enviar: (headers: Record<string, string>) => Promise<Response>): Promise<Response> {
  let res = await enviar(await getAuthHeader());
  if (res.status === 401) {
    const fresh = await refrescarHeader();
    if (fresh.Authorization) res = await enviar(fresh);
  }
  return res;
}

export async function backendGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${FUNCTIONS_BASE}/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await conReintento401((headers) => fetchWithTimeout(url.toString(), { headers }));
  if (!res.ok) throw await errorDeRespuesta(res, path);
  return res.json() as Promise<T>;
}

export async function backendPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await conReintento401((headers) =>
    fetchWithTimeout(`${FUNCTIONS_BASE}/${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
  );
  if (!res.ok) throw await errorDeRespuesta(res, path);
  return res.json() as Promise<T>;
}
