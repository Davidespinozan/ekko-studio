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
  /**
   * PKG-01C: epoch ms en que Stripe creó el objeto pagado. Solo viene cuando el
   * backend reconoce que la MISMA operación ya estaba pagada (`ya_pagado`): la
   * evidencia de activación puede ser anterior a este momento.
   */
  creadoEn?: number;
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
  error?: {
    type?: string;
    code?: string;
    message?: string;
    decline_code?: string;
    /** Stripe.js adjunta el PI cuando el error es por su estado (p. ej. ya pagado en otra pestaña). */
    payment_intent?: { id?: string; status?: string } | null;
  } | null;
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
  pagoEnProcesoPersistido: 'Tienes un pago en proceso. No lo repitas: cuando se confirme, se activará solo.',
  // PKG-01C · al PREPARAR el pago (antes de cobrar nada)
  prepararReintentable: 'No pudimos abrir el pago. Reintenta: si ya estaba preparado, se reutiliza el mismo y no se cobra dos veces.',
  prepararDesconocido: 'No pudimos confirmar si el pago quedó preparado. Reintenta: se reutiliza el mismo intento y no se cobra dos veces.',
  prepararNoIniciable: 'No pudimos preparar este pago. Revisa los datos o acércate a recepción.',
  cobrosNoDisponibles: 'Los pagos online no están disponibles en este momento. Acércate a recepción.',
  intentoReemplazable: 'Este intento de pago quedó sin efecto (cambió el precio o los datos). No se te cobró. Prepara el pago de nuevo.',
  requiereRevision: 'No podemos continuar este pago automáticamente. No lo repitas: el estudio lo revisará.',
  yaPagado: 'Este pago ya se había completado. No se cobró de nuevo.'
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
  if (res?.error) {
    // PKG-01C: la MISMA operación puede reutilizar un PI que otra pestaña ya pagó.
    // Stripe.js responde con error de estado + el PI: si ya está cobrado, NO es
    // un fallo (y ofrecer "reintentar" invitaría a pagar otra vez).
    const piErr = res.error.payment_intent;
    const idErr = typeof piErr?.id === 'string' && piErr.id ? piErr.id : null;
    if (idErr && piErr?.status === 'succeeded') return { tipo: 'confirmado', paymentIntentId: idErr };
    if (idErr && piErr?.status === 'processing') return { tipo: 'en_proceso', paymentIntentId: idErr };
    return { tipo: 'fallido', mensaje: mensajeErrorStripe(res.error) };
  }
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
  // PKG-01C: el derecho ya se observó → las operaciones CONFIRMADAS quedan
  // resueltas; la próxima compra del mismo objetivo es una intención nueva.
  limpiarOperacionesConfirmadas();
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

// ── PKG-01C · Identidad de la operación de pago (localStorage + Web Locks) ────
//
// Un `operation_id` (UUID) por INTENCIÓN de compra (usuario + objetivo). Se
// reutiliza en cada reintento, refresh, reapertura y en otras pestañas; el
// backend lo convierte en la key estable de Stripe (misma operación → mismo
// objeto). Solo se reemplaza con evidencia del servidor (ya_pagado,
// reemplazable, operación inválida) o cuando 02B observa el derecho. La
// antigüedad NUNCA habilita otra operación. Sin PII, sin secretos, sin montos.

export const CLAVE_OPERACIONES_PAGO = 'ekko.operaciones_pago';

interface RegistroOperacion {
  id: string;
  /** epoch ms de creación (solo diagnóstico: no autoriza nada). */
  ts: number;
  /** Stripe.js confirmó el cobro (succeeded) en esta u otra pestaña. */
  confirmada?: boolean;
}

type MapaOperaciones = Record<string, RegistroOperacion>;

const UUID_OPERACION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Respaldo en memoria si localStorage no está disponible (modo privado): cubre reintentos en la misma página. */
const operacionesEnMemoria: MapaOperaciones = {};

function almacenLocal(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function leerMapa(): MapaOperaciones {
  const ls = almacenLocal();
  if (!ls) return operacionesEnMemoria;
  try {
    const raw = ls.getItem(CLAVE_OPERACIONES_PAGO);
    const m = raw ? (JSON.parse(raw) as MapaOperaciones) : {};
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function escribirMapa(m: MapaOperaciones): void {
  const ls = almacenLocal();
  if (!ls) {
    for (const k of Object.keys(operacionesEnMemoria)) delete operacionesEnMemoria[k];
    Object.assign(operacionesEnMemoria, m);
    return;
  }
  try {
    ls.setItem(CLAVE_OPERACIONES_PAGO, JSON.stringify(m));
  } catch {
    Object.assign(operacionesEnMemoria, m);
  }
}

/** Namespace por usuario + objetivo (p. ej. `paquete:<slug>`, `invitados:<reserva>`). */
export function claveOperacionPago(usuarioId: string, objetivo: string): string {
  return `${usuarioId}|${objetivo}`;
}

function registroValido(r: RegistroOperacion | undefined): r is RegistroOperacion {
  return !!r && typeof r.id === 'string' && UUID_OPERACION.test(r.id);
}

function nuevoUuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  c?.getRandomValues?.(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Operación vigente para el objetivo, o null. Solo lectura. */
export function operacionPagoActual(usuarioId: string, objetivo: string): string | null {
  const r = leerMapa()[claveOperacionPago(usuarioId, objetivo)];
  return registroValido(r) ? r.id : null;
}

function leerOCrear(clave: string): string {
  const m = leerMapa();
  const r = m[clave];
  if (registroValido(r)) return r.id;
  m[clave] = { id: nuevoUuid(), ts: Date.now() };
  escribirMapa(m);
  // Releer: si otra pestaña escribió en medio, gana lo persistido.
  const reread = leerMapa()[clave];
  return registroValido(reread) ? reread.id : m[clave].id;
}

interface GestorLocks {
  request<T>(nombre: string, cb: () => Promise<T> | T): Promise<T>;
}

/**
 * Devuelve el operation_id de la intención (usuario + objetivo), creándolo si no
 * existe. Con Web Locks (`navigator.locks`) la lectura/creación es exclusiva
 * entre pestañas del mismo origen → dos pestañas de la misma intención obtienen
 * el MISMO id. Sin Web Locks: lectura → escritura → espera breve → relectura
 * (convergencia conservadora, SIN garantía perfecta de exclusión mutua; el
 * residual queda documentado). La llamada HTTP ocurre fuera del lock.
 */
export async function obtenerOperacionPago(
  usuarioId: string,
  objetivo: string,
  deps: { locks?: GestorLocks | null; esperar?: (ms: number) => Promise<void> } = {}
): Promise<string> {
  const clave = claveOperacionPago(usuarioId, objetivo);
  const locks =
    deps.locks !== undefined
      ? deps.locks
      : typeof navigator !== 'undefined' && (navigator as Navigator & { locks?: GestorLocks }).locks
        ? (navigator as Navigator & { locks: GestorLocks }).locks
        : null;
  if (locks) {
    return locks.request(`ekko-op:${clave}`, () => leerOCrear(clave));
  }
  const existente = operacionPagoActual(usuarioId, objetivo);
  if (existente) return existente;
  const propio = leerOCrear(clave);
  await (deps.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(40);
  return operacionPagoActual(usuarioId, objetivo) ?? propio;
}

/**
 * Descarta la operación SOLO si sigue siendo `id` (no borra una más nueva que otra
 * pestaña ya creó). Uso: el servidor respondió ya_pagado / reemplazable / inválida.
 */
export function descartarOperacionPago(usuarioId: string, objetivo: string, id: string): void {
  const clave = claveOperacionPago(usuarioId, objetivo);
  const m = leerMapa();
  if (m[clave]?.id !== id) return;
  delete m[clave];
  escribirMapa(m);
}

/** Stripe.js confirmó el cobro: la operación queda resuelta cuando 02B observe el derecho. */
export function marcarOperacionConfirmada(usuarioId: string, objetivo: string, id: string): void {
  const clave = claveOperacionPago(usuarioId, objetivo);
  const m = leerMapa();
  if (m[clave]?.id !== id) return;
  m[clave] = { ...m[clave], confirmada: true };
  escribirMapa(m);
}

/** Borra las operaciones ya confirmadas (se llama cuando 02B observa el derecho). */
export function limpiarOperacionesConfirmadas(): void {
  const m = leerMapa();
  let cambio = false;
  for (const [k, r] of Object.entries(m)) {
    if (r?.confirmada) {
      delete m[k];
      cambio = true;
    }
  }
  if (cambio) escribirMapa(m);
}

/** Respuesta del backend al preparar un pago con operación (PKG-01C). */
export type EstadoPreparacion =
  | 'reutilizable'
  | 'en_proceso'
  | 'ya_pagado'
  | 'reemplazable'
  | 'requiere_revision'
  | 'desconocido'
  | 'operacion_invalida'
  | 'reintentable'
  | 'resultado_desconocido'
  | 'pago_no_iniciable'
  | 'cobros_no_disponibles';
