import { backendPost } from '@shared/lib/backend';

/**
 * Compra/cambio de plan del miembro (self-serve). ÚNICO punto de enchufe de
 * Stripe en el frontend: hoy `suscribir-membresia` responde `stripe_pendiente`
 * (sin pasarela); cuando se conecte Stripe devolverá `{ url }` y aquí redirigimos
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

/**
 * Pago IN-APP con Elements sobre la cuenta conectada del estudio. Devuelve el
 * `clientSecret` + `account` (cuenta conectada) que consume <PaymentModal>.
 * `reason` = 'stripe_pendiente' | 'cobros_no_activos' si no se puede cobrar.
 */
export interface PagoIntentResult {
  clientSecret?: string;
  account?: string;
  modo?: 'suscripcion' | 'pago';
  reason?: string;
}

export function crearPagoIntent(tierSlug: string): Promise<PagoIntentResult> {
  return backendPost<PagoIntentResult>('crear-pago-intent', { tier: tierSlug });
}

/**
 * Tarjeta registrada + historial de cobros del miembro, leídos de Stripe sobre
 * la cuenta conectada del estudio (los miembros no pueden leer payment_events).
 */
export interface MetodoPago {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}
export interface PagoHistorial {
  id: string;
  monto_centavos: number;
  moneda: string;
  fecha: string;
  status: string;
  descripcion: string;
}
export interface BillingInfo {
  paymentMethod: MetodoPago | null;
  pagos: PagoHistorial[];
  reason?: string;
}

export function obtenerBillingInfo(): Promise<BillingInfo> {
  return backendPost<BillingInfo>('stripe-billing-info', {});
}

// ── Gestión de la suscripción IN-APP (sin portal de Stripe) ─────────────────

export interface SetupIntentResult {
  clientSecret?: string;
  account?: string;
  reason?: string;
}

/** Crea un SetupIntent para registrar/actualizar la tarjeta con Elements. */
export function crearSetupIntent(): Promise<SetupIntentResult> {
  return backendPost<SetupIntentResult>('stripe-setup-intent', {});
}

/** Fija la nueva tarjeta (pm_...) como default del customer y la suscripción. */
export function actualizarTarjeta(paymentMethodId: string): Promise<{ success: boolean }> {
  return backendPost<{ success: boolean }>('stripe-actualizar-tarjeta', { payment_method: paymentMethodId });
}

/** Cancela al fin del periodo (o reactiva) la suscripción del miembro. */
export function cancelarSuscripcion(reactivar = false): Promise<{ success: boolean; cancel_at_period_end: boolean }> {
  return backendPost<{ success: boolean; cancel_at_period_end: boolean }>('stripe-cancelar-suscripcion', { reactivar });
}
