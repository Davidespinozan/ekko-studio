import type { HandlerResponse } from '@netlify/functions';
import { reportarErrorServidor } from './sentry';

/**
 * PKG-06D · Un error INTERNO nunca viaja crudo al navegador.
 *
 * Clases de error en las funciones de Netlify:
 *  A. dominio esperado (EKKO_* de una RPC, 4xx/409 con texto humano): se responde
 *     tal cual, es parte del contrato (ver `cuentas.ts#respuestaErrorRpc`).
 *  B. validación de entrada (400 con texto escrito a mano): tal cual.
 *  C. autenticación/autorización (401/403 con texto fijo): tal cual.
 *  D. inesperado (Postgres, PostgREST, Supabase Auth/Storage, Stripe, excepción):
 *     evidencia COMPLETA en el servidor (console + Sentry si hay DSN) y una
 *     respuesta 500 ESTABLE y genérica, o un texto humano fijo que dice QUÉ no se
 *     pudo hacer, nunca POR QUÉ técnico.
 *
 * `seguro: true` marca que el texto de `error` fue escrito a mano en el servidor
 * (no es un mensaje de proveedor): el cliente (`backend.ts`) solo muestra el
 * `error` de un 5xx cuando trae esa marca; un `serverError(e.message)` que
 * quedara por ahí se enmascara en el cliente. Defensa en profundidad: la
 * frontera real sigue siendo el servidor.
 */

export const MENSAJE_ERROR_INTERNO = 'No se pudo completar la operación. Intenta de nuevo.';

export function errorInterno(
  funcion: string,
  err: unknown,
  mensaje: string = MENSAJE_ERROR_INTERNO,
  contexto: Record<string, unknown> = {}
): HandlerResponse {
  // Evidencia del lado del servidor: mensaje real y contexto. No se espera el
  // flush (Sentry puede no estar configurado) para no alargar la respuesta.
  void reportarErrorServidor(funcion, err, contexto);
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: mensaje, codigo: 'interno', seguro: true })
  };
}

/** Respuesta 500 con texto humano fijo (parcial honesto, etc.), marcada como segura. */
export function errorSeguro(mensaje: string, extra: Record<string, unknown> = {}): HandlerResponse {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: mensaje, seguro: true, ...extra })
  };
}
