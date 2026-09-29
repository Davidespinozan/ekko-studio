/**
 * PKG-02B (C04) · Veracidad del pago.
 *
 *   PAYMENT STARTED ≠ PAYMENT SUCCEEDED
 *   PAYMENT SUCCEEDED ≠ ENTITLEMENT CONFIRMED
 *   POLLING TIMEOUT ≠ PAYMENT FAILED
 *   UNKNOWN ≠ SUCCESS
 *   UNKNOWN PAYMENT OUTCOME ≠ SAFE TO CHARGE AGAIN
 *
 * Helpers PUROS para que la UI afirme solo lo que sabe: interpretar el resultado
 * de `stripe.confirmPayment`, el retorno de un método con redirección, y el
 * contexto mínimo de un pago cuyo resultado aún no se resolvió (sessionStorage).
 * Nada aquí crea pagos, escribe en la base ni decide entitlement.
 */

/** Flujo desde el que se abrió el pago (para volver al sitio correcto tras un redirect). */
export type FlujoPago = 'perfil' | 'pagar' | 'hora' | 'invitados';

/** Evidencia mínima de un pago confirmado por Stripe.js (status = succeeded). */
export interface PagoConfirmado {
  paymentIntentId: string;
}

export type ResultadoPago =
  | { tipo: 'confirmado'; paymentIntentId: string }
  | { tipo: 'en_proceso'; paymentIntentId: string }
  | { tipo: 'requiere_accion'; paymentIntentId: string | null }
  | { tipo: 'requiere_metodo'; paymentIntentId: string | null }
  | { tipo: 'fallido'; mensaje: string }
  | { tipo: 'desconocido'; paymentIntentId: string | null };

/** Forma mínima de `PaymentIntentResult` de Stripe.js (no dependemos de sus tipos aquí). */
export interface ResultadoConfirmPayment {
  paymentIntent?: { id?: string; status?: string } | null;
  error?: { type?: string; code?: string; message?: string; decline_code?: string } | null;
}

/** Mensaje de error de Stripe.js que SÍ es apto para el usuario (lo redacta Stripe para mostrarse). */
const TIPOS_ERROR_STRIPE_MOSTRABLES = new Set(['card_error', 'validation_error']);

export const MENSAJE_PAGO = {
  fallidoGenerico: 'No se pudo procesar el pago. Revisa el método de pago e intenta de nuevo.',
  enProceso: 'Tu pago está en proceso. No lo repitas: te avisaremos en la app cuando se confirme.',
  requiereAccion: 'Falta completar la verificación del pago. Intenta de nuevo y sigue los pasos de tu banco.',
  requiereMetodo: 'El pago no se completó. Revisa el método de pago e intenta de nuevo.',
  desconocido: 'No pudimos confirmar el resultado del pago. No lo repitas: comprueba tu membresía en unos minutos.',
  noCompletado: 'El pago no se completó. Puedes revisar el método e intentar de nuevo.',
  recibidoActivando: 'Pago recibido. Estamos activando tu membresía; suele tardar unos segundos.',
  activacionTarda: 'Pago recibido. La activación está tardando más de lo normal. No vuelvas a pagar: en cuanto se refleje, aparecerá aquí.',
  activacionSinConfirmar: 'No pudimos confirmar automáticamente la activación. No vuelvas a pagar todavía: vuelve a comprobar o contacta al estudio.',
  comprobacionFallo: 'No pudimos comprobar la activación. Revisa tu conexión e intenta de nuevo.',
  pagoEnProcesoPersistido: 'Tienes un pago en proceso. No lo repitas: cuando se confirme, se activará solo.'
} as const;

/** Copy seguro para un error de Stripe.js: solo se muestra el de Stripe cuando Stripe lo redactó para el usuario. */
export function mensajeErrorStripe(error: { type?: string; message?: string } | null | undefined): string {
  if (error && TIPOS_ERROR_STRIPE_MOSTRABLES.has(error.type ?? '') && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return MENSAJE_PAGO.fallidoGenerico;
}

/**
 * Traduce el resultado REAL de `confirmPayment` a lo que la UI puede afirmar.
 * "Sin error" NO es "pagado": solo `status === 'succeeded'` es confirmado.
 */
export function interpretarResultadoPago(res: ResultadoConfirmPayment | null | undefined): ResultadoPago {
  if (res?.error) return { tipo: 'fallido', mensaje: mensajeErrorStripe(res.error) };
  const pi = res?.paymentIntent;
  const id = typeof pi?.id === 'string' && pi.id ? pi.id : null;
  switch (pi?.status) {
    case 'succeeded':
      return id ? { tipo: 'confirmado', paymentIntentId: id } : { tipo: 'desconocido', paymentIntentId: null };
    case 'processing':
      return id ? { tipo: 'en_proceso', paymentIntentId: id } : { tipo: 'desconocido', paymentIntentId: null };
    case 'requires_action':
    case 'requires_confirmation':
      return { tipo: 'requiere_accion', paymentIntentId: id };
    case 'requires_payment_method':
    case 'canceled':
      return { tipo: 'requiere_metodo', paymentIntentId: id };
    // requires_capture no aplica a EKKO (captura automática); cualquier otra
    // cosa, o ausencia de PI, es desconocido: ni éxito ni "vuelve a pagar".
    default:
      return { tipo: 'desconocido', paymentIntentId: id };
  }
}

/** Mensaje que el modal muestra para un resultado NO confirmado. */
export function mensajeParaResultado(r: ResultadoPago): string {
  switch (r.tipo) {
    case 'fallido': return r.mensaje;
    case 'en_proceso': return MENSAJE_PAGO.enProceso;
    case 'requiere_accion': return MENSAJE_PAGO.requiereAccion;
    case 'requiere_metodo': return MENSAJE_PAGO.requiereMetodo;
    case 'desconocido': return MENSAJE_PAGO.desconocido;
    case 'confirmado': return '';
  }
}

// ── Retorno de métodos con redirección (iDEAL, Bancontact, EPS…) ─────────────

export type EstadoRetorno = 'succeeded' | 'processing' | 'failed' | 'desconocido';

export interface RetornoPago {
  flujo: FlujoPago | null;
  estado: EstadoRetorno | null;
  paymentIntentId: string | null;
}

const FLUJOS: readonly FlujoPago[] = ['perfil', 'pagar', 'hora', 'invitados'];

/** URL de retorno que Stripe usa tras un redirect: conserva el flujo; Stripe añade `payment_intent` y `redirect_status`. */
export function urlRetornoPago(origin: string, flujo: FlujoPago): string {
  const ruta: Record<FlujoPago, string> = {
    perfil: '/app/perfil',
    pagar: '/app',
    hora: '/app/reservar',
    invitados: '/app/reservas'
  };
  return `${origin}${ruta[flujo]}?pago=${flujo}`;
}

/**
 * Lee lo que Stripe devuelve en la URL. `redirect_status` es `succeeded`,
 * `processing` o `requires_payment_method` (fallo); cualquier otro valor es
 * desconocido. El `payment_intent_client_secret` se IGNORA (nunca se guarda).
 * Devuelve `estado: null` si la URL no viene de un retorno de pago.
 */
export function leerRetornoPago(search: string): RetornoPago {
  const p = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const flujoRaw = p.get('pago');
  const flujo = FLUJOS.includes(flujoRaw as FlujoPago) ? (flujoRaw as FlujoPago) : null;
  const rs = p.get('redirect_status');
  const pi = p.get('payment_intent');
  let estado: EstadoRetorno | null = null;
  if (rs === 'succeeded') estado = 'succeeded';
  else if (rs === 'processing' || rs === 'pending') estado = 'processing';
  else if (rs === 'requires_payment_method' || rs === 'failed') estado = 'failed';
  else if (rs !== null) estado = 'desconocido';
  return { flujo, estado, paymentIntentId: pi && /^pi_[A-Za-z0-9_]+$/.test(pi) ? pi : null };
}

// ── Contexto mínimo de un pago no resuelto (sessionStorage) ──────────────────

export type EstadoPagoPendiente = 'confirmado' | 'en_proceso' | 'desconocido';

export interface PagoPendiente {
  flujo: FlujoPago;
  /** Identificador técnico del intento (pi_…). No es PII. */
  paymentIntentId: string | null;
  estado: EstadoPagoPendiente;
  /** Epoch ms de cuando se registró. */
  ts: number;
  /** Datos técnicos para retomar el flujo (ids, hora). Nunca PII ni secretos. */
  contexto?: Record<string, string | number>;
}

export const CLAVE_PAGO_PENDIENTE = 'ekko.pago_pendiente';
/** A partir de aquí la UX cambia el mensaje ("no pudimos confirmar automáticamente"); NUNCA reofrece pagar. */
export const PAGO_PENDIENTE_ANTIGUO_MS = 30 * 60 * 1000;

const CLAVES_PROHIBIDAS = /secret|email|nombre|name|telefono|phone|token/i;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function guardarPagoPendiente(p: Omit<PagoPendiente, 'ts'> & { ts?: number }): PagoPendiente {
  const limpio: PagoPendiente = {
    flujo: p.flujo,
    paymentIntentId: p.paymentIntentId,
    estado: p.estado,
    ts: p.ts ?? Date.now(),
    ...(p.contexto ? { contexto: Object.fromEntries(Object.entries(p.contexto).filter(([k]) => !CLAVES_PROHIBIDAS.test(k))) } : {})
  };
  try {
    storage()?.setItem(CLAVE_PAGO_PENDIENTE, JSON.stringify(limpio));
  } catch {
    /* sin storage (modo privado): la UI funciona igual dentro de la sesión */
  }
  return limpio;
}

export function leerPagoPendiente(flujo?: FlujoPago): PagoPendiente | null {
  try {
    const raw = storage()?.getItem(CLAVE_PAGO_PENDIENTE);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PagoPendiente>;
    if (!p || !FLUJOS.includes(p.flujo as FlujoPago) || typeof p.ts !== 'number') return null;
    if (!['confirmado', 'en_proceso', 'desconocido'].includes(p.estado as string)) return null;
    if (flujo && p.flujo !== flujo) return null;
    return p as PagoPendiente;
  } catch {
    return null;
  }
}

export function limpiarPagoPendiente(): void {
  try {
    storage()?.removeItem(CLAVE_PAGO_PENDIENTE);
  } catch {
    /* nada */
  }
}

/** Solo cambia el COPY: un pendiente antiguo sigue bloqueando un nuevo cobro. */
export function pagoPendienteEsAntiguo(p: PagoPendiente, ahora = Date.now()): boolean {
  return ahora - p.ts >= PAGO_PENDIENTE_ANTIGUO_MS;
}

/** Mensaje para un pendiente persistido según su estado y antigüedad. */
export function mensajePagoPendiente(p: PagoPendiente, ahora = Date.now()): string {
  if (p.estado === 'en_proceso') return MENSAJE_PAGO.pagoEnProcesoPersistido;
  if (p.estado === 'desconocido') return MENSAJE_PAGO.desconocido;
  return pagoPendienteEsAntiguo(p, ahora) ? MENSAJE_PAGO.activacionSinConfirmar : MENSAJE_PAGO.activacionTarda;
}
