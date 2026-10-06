import { backendPost } from '@shared/lib/backend';
import type { EstadoPreparacion } from '@shared/lib/pagoEstado';

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
 * Venta en mostrador (recepción/admin). PKG-01D: pasa por la primitiva
 * transaccional `registrar_venta_mostrador` (vía la Netlify Function): evidencia
 * financiera durable con snapshot del precio + activación por el RPC de R1, en
 * una sola transacción e idempotente por `operationId`.
 */
export type MetodoMostrador = 'efectivo' | 'transferencia' | 'terminal' | 'cortesia';

export const METODOS_MOSTRADOR: ReadonlyArray<{ valor: MetodoMostrador; label: string }> = [
  { valor: 'efectivo', label: 'Efectivo' },
  { valor: 'transferencia', label: 'Transferencia' },
  { valor: 'terminal', label: 'Terminal (tarjeta)' },
  { valor: 'cortesia', label: 'Cortesía' }
];

export interface VentaMostrador {
  id: string | null;
  membresia_id: string | null;
  metodo: MetodoMostrador;
  precio_lista_centavos: number | null;
  monto_cobrado_centavos: number | null;
  moneda: string | null;
}

export interface ActivarResult {
  success: boolean;
  /** true = la misma operación ya se había registrado; no hubo efecto nuevo. */
  idempotente?: boolean;
  venta?: VentaMostrador;
  result?: unknown;
}

/**
 * Identidad de UNA venta lógica. Se genera una vez por intención (al abrir el
 * modal) y se reutiliza en cada reintento: el servidor devuelve la misma venta
 * en vez de activar dos veces. No contiene PII.
 */
export function nuevaOperacionMostrador(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c?.getRandomValues?.(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Importe que cobra el servidor según D9: cortesía = 0; el resto, el precio de lista. */
export function montoCobradoMostrador(precioListaCentavos: number, metodo: MetodoMostrador): number {
  return metodo === 'cortesia' ? 0 : precioListaCentavos;
}

/**
 * `confirmarPerdida`: pasar a un plan sin créditos quema el saldo del paquete
 * anterior. Sin `true`, el servidor responde 409 (ver `esPerdidaDeCreditos`) y la
 * pantalla debe preguntar antes de reintentar con `true` y el MISMO operationId.
 * El cliente NO manda importes: el servidor los deriva del catálogo.
 */
export function activarMembresiaMostrador(
  usuario_id: string,
  tier: string,
  opts: { operationId: string; metodo: MetodoMostrador; confirmarPerdida?: boolean; nota?: string; referencia?: string }
): Promise<ActivarResult> {
  return backendPost<ActivarResult>('reception-activar-membresia', {
    usuario_id,
    tier,
    operation_id: opts.operationId,
    metodo: opts.metodo,
    confirmar_perdida: opts.confirmarPerdida === true,
    ...(opts.nota ? { nota: opts.nota } : {}),
    ...(opts.referencia ? { referencia: opts.referencia } : {})
  });
}

/**
 * ¿El error es el 409 "perdería créditos" de `reception-activar-membresia`?
 * Devuelve cuántos créditos están en juego (1 si no se pudo leer), o null.
 * PKG-01D: otros 409 (suscripción de Stripe viva, operación en conflicto) NO son
 * pérdida de créditos; se distinguen por el texto porque backend.ts solo
 * conserva el mensaje.
 */
export function esPerdidaDeCreditos(e: unknown): number | null {
  const err = e as { status?: number; message?: string } | null;
  if (err?.status !== 409) return null;
  if (!/cr[eé]dito/i.test(err.message ?? '')) return null;
  const n = Number.parseInt(err.message?.match(/(\d+)/)?.[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Clasifica los 409 de una venta de mostrador que NO son pérdida de créditos. */
export function conflictoVentaMostrador(e: unknown): 'suscripcion_stripe' | 'operacion_conflicto' | null {
  const err = e as { status?: number; message?: string } | null;
  if (err?.status !== 409) return null;
  if (/suscripci[oó]n de Stripe/i.test(err.message ?? '')) return 'suscripcion_stripe';
  if (/ya se registr[oó]/i.test(err.message ?? '')) return 'operacion_conflicto';
  return null;
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
  /** PKG-01C: veredicto de la operación (ausente en respuestas legacy / sin Stripe). */
  estado?: EstadoPreparacion;
  operationId?: string;
  /** Id técnico del objeto de Stripe de la operación (pi_/sub_). */
  objetoId?: string;
  /** epoch ms de creación del objeto. */
  creadoEn?: number;
  /** Importe REAL del objeto (centavos) — puede ser el de una operación anterior a un cambio de precio. */
  monto?: number | null;
  moneda?: string;
  /** Mensual: id de la suscripción (la membresía se observa por `stripe_subscription_id`). */
  subscriptionId?: string;
  /** PKG-01F: con `estado: 'perderia_creditos'`, créditos vivos que se perderían al pasar a mensual. */
  creditos?: number;
}

/** PKG-01C: `operationId` = una intención de compra; se reutiliza en cada reintento. */
export function crearPagoIntent(tierSlug: string, operationId?: string, opts: { confirmarPerdidaCreditos?: boolean } = {}): Promise<PagoIntentResult> {
  return backendPost<PagoIntentResult>('crear-pago-intent', {
    tier: tierSlug,
    ...(operationId ? { operation_id: operationId } : {}),
    // PKG-01F (D-01F-6): consentimiento explícito para perder créditos al pasar a mensual.
    ...(opts.confirmarPerdidaCreditos ? { confirmar_perdida_creditos: true } : {})
  });
}

/**
 * PKG-01E · "Tarjeta por Stripe" en mostrador: el STAFF prepara el cobro de un
 * plan para un MIEMBRO objetivo (paquete → PaymentIntent; mensual → suscripción
 * `default_incomplete`) y el miembro introduce su tarjeta en Stripe Elements en
 * el dispositivo de recepción. Devuelve el mismo shape que `crearPagoIntent`.
 * La evidencia es `payment_events` y la activación la hace el webhook: aquí no
 * se activa nada ni se toca `ventas_mostrador`. `operationId` = una intención
 * por (miembro, plan); se reutiliza en cada reintento.
 */
export function crearPagoMostrador(usuarioId: string, tierSlug: string, operationId: string, opts: { confirmarPerdidaCreditos?: boolean } = {}): Promise<PagoIntentResult> {
  return backendPost<PagoIntentResult>('mostrador-crear-pago', {
    usuario_id: usuarioId,
    tier: tierSlug,
    operation_id: operationId,
    ...(opts.confirmarPerdidaCreditos ? { confirmar_perdida_creditos: true } : {})
  });
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
  tier_anterior?: string | null;
  reason?: string;
  /** PKG-01F: rechazo de negocio (HTTP 200): reservas_incompatibles | morosidad | cancelacion_programada | cobro_fallido | operacion_conflicto | estado_no_permitido | sub_no_verificada | requiere_revision | reintentable | resultado_desconocido | pago_no_iniciable */
  code?: string;
  error?: string;
  reservas?: Array<{ reserva_id: string; folio: string; slot_inicio: string; recurso: string; invitados: number; motivo: string }>;
  direccion?: 'upgrade' | 'downgrade' | 'lateral';
  idempotente?: boolean;
  recuperado?: boolean;
  /** Upgrade: factura de prorrata cobrada por Stripe. */
  cobro?: { invoice_id: string | null; amount_paid_centavos: number | null; moneda: string | null } | null;
}

/** PKG-01F: `operationId` = una intención de cambio; se reutiliza en cada reintento (misma key en Stripe). */
export function cambiarPlanSuscripcion(tierSlug: string, operationId: string): Promise<SwapPlanResult> {
  return backendPost<SwapPlanResult>('cambiar-plan-suscripcion', { tier: tierSlug, operation_id: operationId });
}

/** Un rechazo con `code` cuya operación queda TERMINAL (no se puede reintentar con el mismo id). */
export const CODIGOS_SWAP_TERMINALES = new Set(['cobro_fallido', 'operacion_conflicto', 'reservas_incompatibles', 'morosidad', 'cancelacion_programada', 'estado_no_permitido', 'sub_no_verificada', 'pago_no_iniciable']);

/**
 * Pago in-app de N invitados EXTRA de una reserva (Stripe, tarjeta guardada).
 * Devuelve el mismo shape que crearPagoIntent para reutilizar el modal de pago.
 */
export function crearPagoInvitados(reservaId: string, cantidad: number, operationId?: string): Promise<PagoIntentResult> {
  return backendPost<PagoIntentResult>('crear-pago-invitados', {
    reserva_id: reservaId,
    cantidad,
    ...(operationId ? { operation_id: operationId } : {})
  });
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

export interface RenovacionResult {
  success: boolean;
  cancel_at_period_end: boolean;
  /** PKG-06B: EKKO ya lo registró pero Stripe aún no lo confirmó (se reintenta solo). */
  stripe_pendiente?: boolean;
}

/**
 * Cancela al fin del periodo (o reactiva) la suscripción del miembro. PKG-06B: la
 * acción lleva su identidad (`operation_id`): el mismo UUID en un reintento
 * converge en la misma operación del servidor.
 */
export function cancelarSuscripcion(reactivar = false, operationId: string = nuevaOperacionMostrador()): Promise<RenovacionResult> {
  return backendPost<RenovacionResult>('stripe-cancelar-suscripcion', { reactivar, operation_id: operationId });
}
