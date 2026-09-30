import type Stripe from 'stripe';

/**
 * PKG-01C · Frontera saliente hacia Stripe (idempotencia / presupuesto / errores).
 *
 *   ONE LOGICAL BUSINESS OPERATION ≤ ONE EXTERNAL FINANCIAL OBJECT
 *   SAME LOGICAL OPERATION → SAME STRIPE IDEMPOTENCY KEY
 *   NETWORK TIMEOUT ≠ SAFE TO RETRY WITH A NEW KEY
 *   UNKNOWN OUTCOME ≠ FAILED OPERATION
 *
 * Una operación lógica la identifica un `operation_id` (UUID) que el cliente
 * genera UNA vez por intención y reutiliza en cada reintento. La key de Stripe se
 * deriva SOLO de la identidad de la operación (tipo, cuenta, usuario, operación):
 * nunca del precio, la comisión ni la configuración — un cambio entre intentos no
 * puede producir un segundo objeto para la misma operación.
 *
 * Recuperación: antes de crear se BUSCA el objeto de esa operación (metadata
 * `operation_id`) y se clasifica por su estado OBSERVABLE; no se depende de la
 * cabecera `Idempotent-Replayed`. Nada de aquí concede entitlement: eso sigue
 * siendo del webhook (01A/01B).
 *
 * El presupuesto de tiempo es INTERNO y conservador (8 s desde el inicio del
 * handler). No es el límite de la plataforma: la seguridad financiera depende de
 * la idempotencia, no del timeout.
 */

// ── Identidad de la operación ────────────────────────────────────────────────

export type KindOperacion = 'pi_paquete' | 'sub_mensual' | 'pi_invitados' | 'cs_paquete' | 'cs_mensual';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OperationIdLeido = { tipo: 'ausente' } | { tipo: 'invalido' } | { tipo: 'ok'; id: string };

/** Lee el `operation_id` del body. Ausente = cliente legacy; cualquier otra cosa que no sea UUID = inválido. */
export function leerOperationId(v: unknown): OperationIdLeido {
  if (v === undefined || v === null || v === '') return { tipo: 'ausente' };
  if (typeof v !== 'string' || !UUID_RE.test(v)) return { tipo: 'invalido' };
  return { tipo: 'ok', id: v.toLowerCase() };
}

/** Key estable de la operación. `acct` y `usuarioId` salen del servidor (tenant / JWT), nunca del cliente. */
export function llaveOperacion(kind: KindOperacion, acct: string, usuarioId: string, operationId: string): string {
  return `ekko:v1:${kind}:${acct}:${usuarioId}:${operationId}`;
}

/** Key de la invalidación (cancel/expire) de ESA operación: también estable. */
export function llaveInvalidacion(kind: KindOperacion, acct: string, usuarioId: string, operationId: string): string {
  return `${llaveOperacion(kind, acct, usuarioId, operationId)}:invalidar`;
}

/** Customer del miembro en la cuenta conectada: uno por (cuenta, usuario). */
export function llaveCustomer(acct: string, usuarioId: string): string {
  return `ekko:v1:cus:${acct}:${usuarioId}`;
}

/** Cuenta Express del tenant (plataforma compartida con SALA/HSC → prefijo `ekko:`). */
export function llaveCuentaConectada(tenantId: string): string {
  return `ekko:v1:acct:${tenantId}`;
}

// ── Presupuesto interno de tiempo ────────────────────────────────────────────

export const PRESUPUESTO_TOTAL_MS = 8000;
/** Margen para serializar y responder. */
export const RESERVA_RESPUESTA_MS = 1000;
/** No se inicia una mutación con menos de esto utilizable. */
export const MARGEN_MUTACION_MS = 1500;
export const TIMEOUT_MAX_STRIPE_MS = 4000;
const TIMEOUT_LECTURA_CON_REINTENTO_MS = 3000;

export interface OpcionesLlamada {
  timeout: number;
  maxNetworkRetries: 0 | 1;
}

export interface Presupuesto {
  /** ms que quedan del presupuesto total. */
  restanteMs(): number;
  /** ms utilizables (restante − reserva de respuesta). */
  utilMs(): number;
  /** Timeout máximo permitido para UNA llamada: min(4000, restante − reserva). */
  timeoutMaxMs(): number;
  puedeMutar(): boolean;
  puedeLeer(): boolean;
  /** Mutación crítica: 0 reintentos del SDK (el reintento es la operación completa con la MISMA key). */
  opcionesMutacion(): OpcionesLlamada;
  /** Lectura: 1 reintento solo si caben dos intentos + backoff. */
  opcionesLectura(): OpcionesLlamada;
}

export function crearPresupuesto(o: { totalMs?: number; ahora?: () => number } = {}): Presupuesto {
  const ahora = o.ahora ?? Date.now;
  const total = o.totalMs ?? PRESUPUESTO_TOTAL_MS;
  const inicio = ahora();
  const restanteMs = () => Math.max(0, total - (ahora() - inicio));
  const utilMs = () => Math.max(0, restanteMs() - RESERVA_RESPUESTA_MS);
  const timeoutMaxMs = () => Math.min(TIMEOUT_MAX_STRIPE_MS, utilMs());
  return {
    restanteMs,
    utilMs,
    timeoutMaxMs,
    puedeMutar: () => utilMs() >= MARGEN_MUTACION_MS,
    puedeLeer: () => utilMs() >= 1000,
    opcionesMutacion: () => ({ timeout: timeoutMaxMs(), maxNetworkRetries: 0 }),
    opcionesLectura: () =>
      utilMs() >= 2 * TIMEOUT_LECTURA_CON_REINTENTO_MS + 1000
        ? { timeout: TIMEOUT_LECTURA_CON_REINTENTO_MS, maxNetworkRetries: 1 }
        : { timeout: timeoutMaxMs(), maxNetworkRetries: 0 }
  };
}

/** No hay presupuesto para iniciar la llamada: nada se envió a Stripe. */
export class PresupuestoAgotado extends Error {
  constructor() {
    super('presupuesto_agotado');
  }
}

/** Regla de negocio que impide CREAR (p. ej. tope de invitados). Se responde 400. */
export class RechazoNegocio extends Error {}

// ── Clasificación de errores salientes ───────────────────────────────────────

export type ClaseErrorSaliente = 'conflicto' | 'reintentable' | 'resultado_desconocido' | 'pago_no_iniciable' | 'cobros_no_disponibles';

/**
 * Error de una llamada a Stripe → clase. En una MUTACIÓN, lo que no prueba que
 * Stripe no la ejecutó (conexión cortada, timeout, 5xx) es RESULTADO DESCONOCIDO:
 * el cliente reintenta con la MISMA operación, nunca con otra.
 */
export function clasificarErrorSaliente(e: unknown, fase: 'mutacion' | 'lectura'): ClaseErrorSaliente {
  if (e instanceof PresupuestoAgotado) return 'reintentable';
  const err = (e ?? {}) as { type?: string; rawType?: string; statusCode?: number };
  if (err.type === 'StripeIdempotencyError' || err.rawType === 'idempotency_error' || err.statusCode === 409) return 'conflicto';
  if (err.type === 'StripeAuthenticationError' || err.type === 'StripePermissionError') return 'cobros_no_disponibles';
  if (err.type === 'StripeInvalidRequestError' || err.type === 'StripeCardError') return 'pago_no_iniciable';
  if (err.type === 'StripeRateLimitError' || err.statusCode === 429) return 'reintentable';
  // Conexión/timeout/5xx/desconocido: en una lectura no hay efecto; en una mutación no se sabe.
  return fase === 'mutacion' ? 'resultado_desconocido' : 'reintentable';
}

// ── Veredictos y clasificación por estado observable ─────────────────────────

export type Veredicto =
  | 'reutilizable'
  | 'en_proceso'
  | 'ya_pagado'
  | 'reemplazable'
  | 'requiere_revision'
  | 'desconocido'
  | 'operacion_invalida';

export type VeredictoTransporte = 'reintentable' | 'resultado_desconocido' | 'pago_no_iniciable' | 'cobros_no_disponibles';

export interface Evaluacion {
  veredicto: Veredicto;
  /** Los parámetros financieros del objeto no coinciden con la intención actual. */
  drift: boolean;
  /** Stripe garantiza que invalidarlo (cancel/expire) impide cualquier cobro. */
  invalidable: boolean;
}

/** Lo que la operación actual espera del objeto. `metadata` = referencias de negocio que deben coincidir. */
export interface Esperado {
  target: string;
  amount: number;
  currency: string;
  /** PI: application_fee_amount (centavos). Sub: application_fee_percent. CS: no observable (null). */
  fee: number | null;
  metadata: Record<string, string>;
}

function difiereMetadata(meta: Record<string, string> | null | undefined, esperado: Record<string, string>): boolean {
  return Object.entries(esperado).some(([k, v]) => (meta?.[k] ?? null) !== v);
}

export function clasificarPaymentIntent(
  pi: Pick<Stripe.PaymentIntent, 'status' | 'amount' | 'currency' | 'application_fee_amount' | 'metadata'>,
  esperado: Esperado
): Evaluacion {
  if ((pi.metadata?.ekko_target ?? null) !== esperado.target) {
    return { veredicto: 'operacion_invalida', drift: false, invalidable: false };
  }
  const drift =
    pi.amount !== esperado.amount ||
    (pi.currency ?? '').toLowerCase() !== esperado.currency.toLowerCase() ||
    (esperado.fee !== null && (pi.application_fee_amount ?? 0) !== esperado.fee) ||
    difiereMetadata(pi.metadata, esperado.metadata);
  switch (pi.status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return { veredicto: 'reutilizable', drift, invalidable: true };
    case 'processing':
      return { veredicto: 'en_proceso', drift, invalidable: false };
    case 'succeeded':
      return { veredicto: 'ya_pagado', drift, invalidable: false };
    case 'canceled':
      return { veredicto: 'reemplazable', drift, invalidable: false };
    case 'requires_capture':
      // EKKO no usa captura manual: fondos autorizados = anomalía → revisión.
      return { veredicto: 'requiere_revision', drift, invalidable: false };
    default:
      return { veredicto: 'desconocido', drift, invalidable: false };
  }
}

/**
 * Evidencia FINANCIERA de la primera factura de la suscripción. El `status` de la
 * suscripción por sí solo NO prueba que hubo pago (trialing, past_due, canceled).
 *   pagada      = existe una factura de la sub pagada con importe > 0
 *   anulada     = sin factura pagada y la última ya no es cobrable (void/uncollectible)
 *   no_pagada   = sin factura pagada y la última sigue cobrable (open/draft)
 *   desconocida = no se pudo leer
 */
export type EvidenciaPagoInicial = 'pagada' | 'anulada' | 'no_pagada' | 'desconocida';

type SuscripcionClasificable = Pick<Stripe.Subscription, 'status' | 'metadata' | 'items'> & {
  application_fee_percent?: number | null;
};

export function clasificarSuscripcion(sub: SuscripcionClasificable, esperado: Esperado, evidencia: EvidenciaPagoInicial): Evaluacion {
  if ((sub.metadata?.ekko_target ?? null) !== esperado.target) {
    return { veredicto: 'operacion_invalida', drift: false, invalidable: false };
  }
  const price = sub.items?.data?.[0]?.price;
  const drift =
    (price?.unit_amount ?? null) !== esperado.amount ||
    (price?.currency ?? '').toLowerCase() !== esperado.currency.toLowerCase() ||
    (esperado.fee !== null && (sub.application_fee_percent ?? 0) !== esperado.fee) ||
    difiereMetadata(sub.metadata, esperado.metadata);
  // Cancelar una sub `incomplete` NO garantiza que su primera factura deje de ser
  // pagable → nunca invalidable: se reutiliza la original mostrando su importe real.
  const r = (veredicto: Veredicto): Evaluacion => ({ veredicto, drift, invalidable: false });
  if (evidencia === 'desconocida' && sub.status !== 'incomplete') return r('desconocido');
  switch (sub.status) {
    case 'incomplete':
      if (evidencia === 'pagada') return r('en_proceso'); // pagada; la activación la hace el webhook
      if (evidencia === 'anulada') return r('requiere_revision');
      return r('reutilizable');
    case 'active':
    case 'trialing':
    case 'past_due':
      // Solo con evidencia de primera factura pagada se afirma que hubo pago.
      return r(evidencia === 'pagada' ? 'ya_pagado' : 'requiere_revision');
    case 'canceled':
      if (evidencia === 'pagada') return r('ya_pagado');
      if (evidencia === 'anulada') return r('reemplazable');
      return r('requiere_revision'); // factura aún cobrable: no es seguro reemplazar
    case 'incomplete_expired':
      // Stripe anula la primera factura al expirar; una pagada sería contradicción.
      return r(evidencia === 'pagada' ? 'requiere_revision' : 'reemplazable');
    case 'unpaid':
    case 'paused':
      return r('requiere_revision');
    default:
      return r('desconocido');
  }
}

type SesionClasificable = Pick<Stripe.Checkout.Session, 'status' | 'payment_status' | 'amount_total' | 'currency' | 'mode' | 'metadata' | 'ui_mode' | 'client_secret' | 'url'>;

export function clasificarCheckout(cs: SesionClasificable, esperado: Esperado & { mode: 'payment' | 'subscription'; embedded: boolean }): Evaluacion {
  if ((cs.metadata?.ekko_target ?? null) !== esperado.target) {
    return { veredicto: 'operacion_invalida', drift: false, invalidable: false };
  }
  const embebida = cs.ui_mode === 'embedded';
  const drift =
    (cs.amount_total ?? null) !== esperado.amount ||
    (cs.currency ?? '').toLowerCase() !== esperado.currency.toLowerCase() ||
    cs.mode !== esperado.mode ||
    embebida !== esperado.embedded ||
    difiereMetadata(cs.metadata, esperado.metadata) ||
    // Abierta pero sin forma de retomarla desde el cliente → no reutilizable.
    (cs.status === 'open' && !(embebida ? cs.client_secret : cs.url));
  switch (cs.status) {
    case 'open':
      return { veredicto: 'reutilizable', drift, invalidable: true };
    case 'complete':
      if (cs.payment_status === 'paid') return { veredicto: 'ya_pagado', drift, invalidable: false };
      if (cs.payment_status === 'unpaid') return { veredicto: 'en_proceso', drift, invalidable: false };
      if (cs.payment_status === 'no_payment_required') return { veredicto: 'requiere_revision', drift, invalidable: false };
      return { veredicto: 'desconocido', drift, invalidable: false };
    case 'expired':
      return { veredicto: 'reemplazable', drift, invalidable: false };
    default:
      return { veredicto: 'desconocido', drift, invalidable: false };
  }
}

// ── Orquestación: recuperar la MISMA operación o crearla con la key estable ──

export interface OperacionStripe<T> {
  /** Busca el objeto de ESTA operación (metadata.operation_id). Lanza si la lectura falla. */
  buscar(): Promise<T | null>;
  /** Crea con la key estable de la operación. */
  crear(): Promise<T>;
  evaluar(obj: T): Promise<Evaluacion>;
  /** Cancel/expire: solo se llama si `evaluar` dijo invalidable. */
  invalidar?(obj: T): Promise<T>;
  /** Relee el objeto por id (tras una invalidación fallida). */
  releer?(obj: T): Promise<T>;
}

export type ResultadoOperacion<T> =
  | { tipo: 'objeto'; veredicto: Veredicto; objeto: T; drift: boolean }
  | { tipo: 'transporte'; veredicto: VeredictoTransporte };

const transporte = <T>(veredicto: VeredictoTransporte): ResultadoOperacion<T> => ({ tipo: 'transporte', veredicto });

function aTransporte(clase: ClaseErrorSaliente): VeredictoTransporte {
  return clase === 'conflicto' ? 'resultado_desconocido' : clase;
}

async function resolverExistente<T>(op: OperacionStripe<T>, obj: T, presupuesto: Presupuesto): Promise<ResultadoOperacion<T>> {
  const ev = await op.evaluar(obj);
  if (!(ev.veredicto === 'reutilizable' && ev.drift && ev.invalidable && op.invalidar)) {
    return { tipo: 'objeto', veredicto: ev.veredicto, objeto: obj, drift: ev.drift };
  }
  // Drift sobre un objeto invalidable: se INVALIDA (Stripe garantiza que no cobra)
  // y solo con el nuevo estado observado se declara reemplazable.
  if (!presupuesto.puedeMutar()) return transporte('reintentable');
  try {
    const invalidado = await op.invalidar(obj);
    const ev2 = await op.evaluar(invalidado);
    if (ev2.veredicto === 'reutilizable') return transporte('reintentable');
    return { tipo: 'objeto', veredicto: ev2.veredicto, objeto: invalidado, drift: ev2.drift };
  } catch {
    // Nunca asumir el fallo: releer y reclasificar (pudo avanzar a processing/succeeded).
    if (!op.releer || !presupuesto.puedeLeer()) return transporte('resultado_desconocido');
    try {
      const actual = await op.releer(obj);
      const ev3 = await op.evaluar(actual);
      if (ev3.veredicto === 'reutilizable') return transporte(ev3.drift ? 'reintentable' : 'resultado_desconocido');
      return { tipo: 'objeto', veredicto: ev3.veredicto, objeto: actual, drift: ev3.drift };
    } catch {
      return transporte('resultado_desconocido');
    }
  }
}

/**
 * 1. buscar el objeto de ESA operación → si existe, validar target y clasificar;
 * 2. si no existe, crear con la key estable y clasificar lo devuelto;
 * 3. si el create choca (409/idempotency_error) → buscar de nuevo ESA operación;
 *    si no aparece → resultado desconocido. Nunca se crea con otra key.
 * Una lectura fallida NO habilita crear (no se sabe si el objeto existe).
 */
export async function ejecutarOperacion<T>(op: OperacionStripe<T>, presupuesto: Presupuesto): Promise<ResultadoOperacion<T>> {
  if (!presupuesto.puedeLeer()) return transporte('reintentable');
  let existente: T | null;
  try {
    existente = await op.buscar();
  } catch (e) {
    return transporte(aTransporte(clasificarErrorSaliente(e, 'lectura')));
  }
  if (existente) return resolverExistente(op, existente, presupuesto);

  if (!presupuesto.puedeMutar()) return transporte('reintentable');
  let creado: T;
  try {
    creado = await op.crear();
  } catch (e) {
    if (e instanceof RechazoNegocio) throw e;
    const clase = clasificarErrorSaliente(e, 'mutacion');
    if (clase !== 'conflicto') return transporte(clase);
    if (!presupuesto.puedeLeer()) return transporte('resultado_desconocido');
    try {
      const otra = await op.buscar();
      if (otra) return resolverExistente(op, otra, presupuesto);
    } catch {
      /* cae a resultado desconocido */
    }
    return transporte('resultado_desconocido');
  }
  return resolverExistente(op, creado, presupuesto);
}

/** Busca en una lista el objeto cuya metadata.operation_id sea la operación. */
export function porOperacion<T extends { metadata?: Stripe.Metadata | null }>(lista: T[], operationId: string): T | null {
  return lista.find((o) => o.metadata?.operation_id === operationId) ?? null;
}

/** Evidencia de pago inicial de una suscripción (solo lectura). */
export async function evidenciaPagoInicial(
  stripe: Stripe,
  sub: Pick<Stripe.Subscription, 'id' | 'status' | 'latest_invoice'>,
  opt: { stripeAccount: string },
  presupuesto: Presupuesto
): Promise<EvidenciaPagoInicial> {
  const inv = sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  const pagada = (i: { status?: string | null; amount_paid?: number | null }) => i.status === 'paid' && (i.amount_paid ?? 0) > 0;
  const anulada = (i: { status?: string | null }) => i.status === 'void' || i.status === 'uncollectible';
  if (inv && pagada(inv)) return 'pagada';
  // En `incomplete` la última factura ES la primera: no hace falta leer más.
  if (sub.status === 'incomplete' && inv) return anulada(inv) ? 'anulada' : 'no_pagada';
  if (!presupuesto.puedeLeer()) return 'desconocida';
  try {
    const lista = await stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: 10 }, { ...opt, ...presupuesto.opcionesLectura() });
    if (lista.data.some(pagada)) return 'pagada';
  } catch {
    return 'desconocida';
  }
  if (!inv) return 'desconocida';
  return anulada(inv) ? 'anulada' : 'no_pagada';
}

/** Registro estructurado sin PII (sin email ni nombre; ids técnicos). */
export function registrarOperacion(d: {
  funcion: string;
  kind: KindOperacion;
  usuario_id: string;
  estado: string;
  legacy?: boolean;
  drift?: boolean;
}): void {
  console.info(JSON.stringify({ evento: d.legacy ? 'pago_op_legacy' : 'pago_operacion', ...d }));
}

/**
 * CustomerSession (el PaymentElement muestra la tarjeta guardada). Best-effort:
 * si falla o no sobra presupuesto, se sigue sin tarjeta guardada. El filtro
 * incluye 'unspecified' porque las tarjetas guardadas por la suscripción quedan
 * con ese allow_redisplay y si no, no se listarían.
 */
export async function crearSesionCliente(
  stripe: Stripe,
  customerId: string,
  accountId: string,
  etiqueta: string,
  presupuesto?: Presupuesto
): Promise<string | null> {
  if (presupuesto && presupuesto.utilMs() < 4000) return null;
  try {
    const cs = await stripe.customerSessions.create(
      {
        customer: customerId,
        components: {
          payment_element: {
            enabled: true,
            features: {
              payment_method_redisplay: 'enabled',
              payment_method_allow_redisplay_filters: ['always', 'limited', 'unspecified'],
              payment_method_save: 'enabled',
              payment_method_save_usage: 'off_session',
              payment_method_remove: 'enabled'
            }
          }
        }
      },
      { stripeAccount: accountId, ...(presupuesto ? { timeout: Math.min(2000, presupuesto.timeoutMaxMs()), maxNetworkRetries: 0 as const } : {}) }
    );
    return cs.client_secret;
  } catch (e) {
    console.error(`[${etiqueta}] customerSession`, e instanceof Error ? e.message : e);
    return null;
  }
}
