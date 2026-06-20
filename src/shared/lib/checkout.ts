import { backendPost } from '@shared/lib/backend';

/**
 * Compra/cambio de plan del miembro (self-serve). ÚNICO punto de enchufe de
 * Stripe en el frontend: hoy `suscribir-membresia` responde `stripe_pendiente`
 * (sin pasarela); cuando se conecte Stripe devolverá `{ url }` y acá redirigimos
 * al Checkout — sin tocar la UI. Ver STRIPE.md.
 */

export interface CheckoutResult {
  /** true si la membresía quedó activa ya (atajo simulado, si se habilita). */
  activated?: boolean;
  /** 'stripe_pendiente' cuando aún no hay pasarela (acercate a recepción). */
  reason?: string;
  /** Futuro Stripe: URL de la Checkout Session para redirigir. */
  url?: string;
  result?: unknown;
}

export async function iniciarCheckout(tierSlug: string): Promise<CheckoutResult> {
  const res = await backendPost<CheckoutResult>('suscribir-membresia', { tier: tierSlug });
  if (res.url) {
    window.location.href = res.url; // futuro: Stripe Checkout Session
  }
  return res;
}

/**
 * Activación en mostrador (recepción/admin). Llama al RPC keystone vía la
 * Netlify Function — el MISMO punto de activación que el webhook de Stripe.
 */
export interface ActivarResult {
  success: boolean;
  result?: unknown;
}

export function activarMembresiaMostrador(usuario_id: string, tier: string): Promise<ActivarResult> {
  return backendPost<ActivarResult>('reception-activar-membresia', { usuario_id, tier });
}

/**
 * Abre el Customer Portal de Stripe (cancelar, cambiar tarjeta, ver facturas).
 * Redirige si la respuesta trae `{ url }`; si Stripe aún no está conectado
 * devuelve `{ reason: 'stripe_pendiente' }` y el caller decide qué mostrar.
 */
export interface PortalResult {
  url?: string;
  reason?: string;
}

export async function abrirPortal(): Promise<PortalResult> {
  const res = await backendPost<PortalResult>('stripe-portal', {});
  if (res.url) {
    window.location.href = res.url;
  }
  return res;
}
