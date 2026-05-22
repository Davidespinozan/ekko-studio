import { supabase } from './supabase';
import { fetchWithTimeout } from './fetchWithTimeout';

const FUNCTIONS_BASE = '/.netlify/functions';

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return {};
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Construye un Error a partir de una respuesta no-OK (ERROR-UI-FIX E-06).
 *
 * Las Netlify Functions devuelven `{ error: "mensaje en español" }` en sus
 * respuestas de error (ver `netlify/functions/_lib/http.ts`). Antes esto se
 * descartaba y el caller veía `backendPost <path>: <status>` — un string
 * técnico. Ahora se lee el body y se usa el mensaje del servidor; si el body
 * viene vacío o no es JSON, se cae a `HTTP <status>`.
 */
async function errorDeRespuesta(res: Response): Promise<Error> {
  let mensaje = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string' && body.error.trim()) {
      mensaje = body.error;
    }
  } catch {
    // body vacío o no-JSON → queda el fallback `HTTP <status>`.
  }
  return new Error(mensaje);
}

export async function backendGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${FUNCTIONS_BASE}/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const headers = await getAuthHeader();
  const res = await fetchWithTimeout(url.toString(), { headers });
  if (!res.ok) throw await errorDeRespuesta(res);
  return res.json() as Promise<T>;
}

export async function backendPost<T>(path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeader();
  const res = await fetchWithTimeout(`${FUNCTIONS_BASE}/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw await errorDeRespuesta(res);
  return res.json() as Promise<T>;
}
