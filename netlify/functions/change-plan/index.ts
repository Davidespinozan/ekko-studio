import ws from 'ws';

// supabase-js inicializa Realtime aunque no lo usemos; en Node <22
// no hay WebSocket global. Le damos el de 'ws'.
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler } from '@netlify/functions';
import { badRequest } from '../_lib/http';

/**
 * POST /change-plan
 * Auth: Bearer JWT del miembro (cambia SU PROPIA membresía, nunca la de otro).
 * Body: { tier: <slug de un tier activo del tenant> }
 *
 * Cambio de plan self-serve, en-app. El trigger SEC-FIX C2
 * (`proteger_columnas_privilegiadas_usuarios`) bloquea que el cliente toque
 * `membresia_tier` directamente; por eso el cambio pasa por esta función con
 * service_role.
 *
 * IMPORTANTE — monetización: en la fase actual los pagos son SIMULADOS (no hay
 * Stripe). Esta función cambia el `membresia_tier` pero **NO toca `status`**:
 * no activa cuentas inertes (pendiente_pago sigue sin poder reservar). Cuando
 * se integre Stripe, el cambio de plan debe gatearse detrás del cobro real
 * (Checkout/Customer Portal + webhook) en lugar de aplicarse aquí sin pago.
 */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  // DESACTIVADO (2026-07): este endpoint cambiaba `membresia_tier` SIN cobro, lo
  // que permitía a un miembro auto-escalar de plan gratis (acceso a estudios Pro,
  // más invitados). Ningún flujo del front lo usa: el cambio/compra de plan pasa
  // por `crear-pago-intent` (Stripe) + webhook (`activar_membresia`), que es el
  // único punto que puede tocar el tier tras un pago real. Se deja el 410 como
  // red de seguridad por si alguien lo invoca directo.
  return {
    statusCode: 410,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: 'Endpoint retirado. El cambio de plan se hace pagando vía la app (Stripe).'
    })
  };
};
