import type { Handler } from '@netlify/functions';

/**
 * POST /fake-signup — RETIRADO (PKG-06C · FR-24 · EKKO-146).
 *
 * Creaba la cuenta de Auth con el correo ya "confirmado" sin que nadie lo
 * probara, sin límite de tasa, delataba si un correo ya tenía cuenta y, tras
 * vincular un perfil existente, le reescribía rol/status/plan/notas. El registro
 * público ahora es `alta-publica` (correo verificado por el proveedor antes de
 * cualquier identidad EKKO).
 *
 * Se deja inerte (sin base, sin Auth, sin secretos) solo para que una copia vieja
 * de la app en caché (PWA) reciba un mensaje claro en vez de un 404.
 */
export const handler: Handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ error: 'El registro se actualizó. Recarga la página para continuar.', seguro: true })
});
