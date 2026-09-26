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

/**
 * `confirmarPerdida`: pasar a un plan sin créditos quema el saldo del paquete
 * anterior. Sin `true`, el servidor responde 409 (ver `esPerdidaDeCreditos`) y la
 * pantalla debe preguntar antes de reintentar con `true`.
 */
export function activarMembresiaMostrador(
  usuario_id: string,
  tier: string,
  opts: { confirmarPerdida?: boolean; motivo?: string } = {}
): Promise<ActivarResult> {
  return backendPost<ActivarResult>('reception-activar-membresia', {
    usuario_id,
    tier,
    confirmar_perdida: opts.confirmarPerdida === true,
    // Queda en audit_log: cómo pagó / por qué se asignó sin pasar por Stripe.
    ...(opts.motivo ? { motivo: opts.motivo } : {})
  });
}

/**
 * ¿El error es el 409 "perdería créditos" de `reception-activar-membresia`?
 * Devuelve cuántos créditos están en juego (1 si no se pudo leer), o null.
 */
export function esPerdidaDeCreditos(e: unknown): number | null {
  const err = e as { status?: number; message?: string } | null;
  if (err?.status !== 409) return null;
  const n = Number.parseInt(err.message?.match(/(\d+)/)?.[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
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
  /** CustomerSession: hace que el PaymentElement muestre la tarjeta guardada. */
  customerSessionClientSecret?: string | null;
}

export function crearPagoIntent(tierSlug: string): Promise<PagoIntentResult> {
  return backendPost<PagoIntentResult>('crear-pago-intent', { tier: tierSlug });
}

/**
 * Cambio de plan MENSUAL↔MENSUAL sin re-pedir tarjeta: re-precio de la suscripción
 * vigente cobrando la tarjeta guardada (proration al próximo período). Si el miembro
 * no tiene una suscripción activa (paquete/cancelado) o el destino es un paquete,
 * devuelve `{ reason: 'sin_suscripcion' }` y el caller cae al PaymentModal normal.
 */
export interface SwapPlanResult {
  success?: boolean;
  tier?: string;
  reason?: string;
}

export function cambiarPlanSuscripcion(tierSlug: string): Promise<SwapPlanResult> {
  return backendPost<SwapPlanResult>('cambiar-plan-suscripcion', { tier: tierSlug });
}

/**
 * Pago in-app de N invitados EXTRA de una reserva (Stripe, tarjeta guardada).
 * Devuelve el mismo shape que crearPagoIntent para reutilizar el modal de pago.
 */
export function crearPagoInvitados(reservaId: string, cantidad: number): Promise<PagoIntentResult> {
  return backendPost<PagoIntentResult>('crear-pago-invitados', { reserva_id: reservaId, cantidad });
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
  /** 'succeeded' | 'pending' | 'failed' | 'refunded' */
  status: string;
  /** Concepto legible: "Renovación de membresía · Esencial", "Paquete · 4 horas", "Invitados extra (2)". */
  descripcion: string;
  /** Recibo de Stripe; null si el cargo no lo trae (o backend viejo). */
  receipt_url?: string | null;
  /** Centavos devueltos (parcial o total). */
  reembolsado_centavos?: number;
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
