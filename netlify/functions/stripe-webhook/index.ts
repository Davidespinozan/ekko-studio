import ws from 'ws';

if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, serverError } from '../_lib/http';
import { requireEnv } from '../_lib/env';
import {
  getStripe,
  clasificarEvento,
  periodoFinFromSubscription,
  extraerMontoDeEvento,
  resumenEvento,
  redactarPayload,
  clasificarError,
  accionIdempotente,
  DivergenciaWebhook,
  ErrorRpcWebhook,
  type EventoClasificado,
  type EstadoEventoWebhook,
  type MontoEvento
} from '../_lib/stripe';
import { enviarEmail, emailPagoFallido, emailBienvenida, emailRecibo, emailPaqueteComprado, identidadEstudio, motivoPersistible, type EmailRenderizado } from '../_lib/email';
import { reportarErrorServidor } from '../_lib/sentry';
import { avisarStaff } from '../_lib/avisosStaff';

/**
 * POST /stripe-webhook — materializa los cambios de la suscripción del miembro.
 *
 * PKG-01A · Estado durable del evento. Cada evento firmado de EKKO deja UNA
 * fila en `stripe_webhook_events` cuyo `estado` es la verdad:
 *
 *   claim (RPC atómico) ─► en_proceso ─► efecto ─► diario ─► procesado (200)
 *                              │                              ignorado  (200)  regla explícita
 *                              ├─ fallo transitorio ────────► error_reintentable (5xx, Stripe reintenta)
 *                              └─ permanente / divergencia ─► revision (200 + aviso al staff; una
 *                                                              re-entrega desde Stripe lo vuelve a reclamar)
 *
 * Reglas (A1): solo se responde 2xx si el evento quedó procesado, ignorado por
 * regla explícita, o en revisión con evidencia + aviso + re-entrega posible.
 * Todo lo demás responde 5xx para que Stripe reintente. La fila NUNCA se borra.
 *
 *   - Firma verificada sobre el BODY CRUDO (no JSON.parse).
 *   - Un event.id → una sola reclamación activa (claim_stripe_event, lease 60 s);
 *     la entrega concurrente que no la obtiene responde 503 sin tocar negocio.
 *   - Orden: el RPC `sync_membresia_stripe` (R1) ignora eventos más viejos.
 *
 * Activación (checkout.session.completed / 1ª factura) → RPC `activar_membresia`
 * (el MISMO punto que usa recepción). Cambios posteriores → `sync_membresia_stripe`.
 */

/** Lease de la reclamación: una function de Netlify vive ≤ 26 s; a los 60 s el intento anterior murió. */
const LEASE_SEGUNDOS = 60;
/** Intentos (entregas de Stripe reclamadas) antes de dejar de reintentar un fallo "transitorio". */
const MAX_INTENTOS = 8;

type Claim = {
  resultado: 'nuevo' | 'reclamado' | 'duplicado' | 'en_curso';
  estado_previo: EstadoEventoWebhook | null;
  accion_previa: string | null;
  intentos: number;
};

const respuesta = (statusCode: number, body: unknown): HandlerResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

/**
 * Suscripciones de Stripe vivas del socio DISTINTAS de la nueva. Se consulta
 * ANTES de activar (activar_membresia cancela las filas), para poder cancelarlas
 * luego en Stripe y evitar doble cobro tras un cambio de plan.
 */
async function subsAnterioresDelSocio(
  admin: any,
  usuarioId: string,
  nuevaSubId: string | null | undefined
): Promise<string[]> {
  const { data } = await admin
    .from('membresias')
    .select('stripe_subscription_id')
    .eq('usuario_id', usuarioId)
    // 'pausada' incluida: si no, la sub en pausa sobrevive al cambio de plan y
    // vuelve a cobrar el día que alguien la reanude.
    .in('status', ['trialing', 'activa', 'past_due', 'pausada'])
    .not('stripe_subscription_id', 'is', null);
  const rows = (data ?? []) as Array<{ stripe_subscription_id: string | null }>;
  const ids = rows
    .map((m) => m.stripe_subscription_id)
    .filter((id): id is string => !!id && id !== nuevaSubId);
  return [...new Set(ids)];
}

/** Cancela en Stripe cada suscripción anterior (best-effort; no rompe el webhook). */
async function cancelarSubsAnteriores(
  stripe: ReturnType<typeof getStripe>,
  subIds: string[],
  acctOpt: { stripeAccount: string } | undefined
): Promise<void> {
  for (const subId of subIds) {
    try {
      await stripe.subscriptions.cancel(subId, acctOpt);
    } catch (e) {
      console.error('[stripe-webhook] no se pudo cancelar sub anterior', subId, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Transición final de la fila (solo desde `en_proceso`, que es la reclamación
 * de ESTA ejecución). Lanza si la escritura falla o no afecta ninguna fila:
 * un estado final que no se pudo persistir no es un éxito.
 */
async function finalizar(
  admin: any,
  eventId: string,
  estado: Exclude<EstadoEventoWebhook, 'en_proceso'>,
  campos: { accion?: string | null; motivo?: string | null; ultimo_error?: string | null }
): Promise<void> {
  const terminal = estado === 'procesado' || estado === 'ignorado';
  const patch: Record<string, unknown> = {
    estado,
    accion: campos.accion ?? null,
    motivo: campos.motivo ?? null,
    ultimo_error: campos.ultimo_error ?? null,
    lease_hasta: null,
    processed_at: terminal ? new Date().toISOString() : null
  };
  const { data, error } = await admin
    .from('stripe_webhook_events')
    .update(patch)
    .eq('id', eventId)
    .eq('estado', 'en_proceso')
    .select('id');
  if (error) throw new ErrorRpcWebhook('finalizar stripe_webhook_events', error);
  if (!data || data.length === 0) {
    throw new Error(`finalizar stripe_webhook_events: la fila ${eventId} ya no estaba en_proceso`);
  }
}

/** Aviso al equipo cuando un evento queda en revisión (solo admins; best-effort). */
async function avisarRevision(
  admin: any,
  ev: { id: string; type: string },
  motivo: string,
  tenantId: string | null
): Promise<void> {
  if (!tenantId) return;
  await avisarStaff(admin, {
    tenant_id: tenantId,
    tipo: 'stripe_revision',
    titulo: 'Evento de Stripe en revisión',
    mensaje: `El evento ${ev.type} (${ev.id}) no se pudo aplicar: ${motivo}. Revisa el evento en Stripe y reenvíalo cuando esté corregido.`,
    metadata: { event_id: ev.id, type: ev.type, motivo },
    url: '/admin/cobros',
    soloAdmins: true
  });
}

/** Resultado de la acción de dinero: lo que necesita el diario y los avisos. */
type Efecto = {
  resultado: string;
  /** PKG-01B: la acción decidió que NO hay nada que aplicar (regla explícita) → fila `ignorado` con este motivo. */
  ignorar?: string;
  usuarioIdPago: string | null;
  membresiaIdPago: string | null;
  paqueteActivado: { creditos: number | null; periodo_fin: string | null } | null;
  reportes: Array<{ error: Error; extra: Record<string, unknown> }>;
  /** PKG-01G: reversal registrado (para avisar a admins después de `procesado`). */
  reversal?: { tipo: 'reembolso' | 'disputa'; nuevo: boolean; estado: string; monto: number; moneda: string; origen: string | null; objectId: string } | null;
  /** PKG-01G: desautorización de Connect aplicada (null si fue idempotente). */
  cuentaDesautorizada?: { tenantId: string } | null;
  /** PKG-01H: pago de invitados extra que no pudo aplicarse (primera vez). */
  extrasNoAplicados?: { tenantId: string; motivo: string; paymentIntentId: string; cantidad: number; monto: number; moneda: string } | null;
};

/** Tenant por el pago original (cuando el evento no trae `account`). */
async function tenantPorPaymentIntent(admin: any, paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId) return null;
  const { data } = await admin
    .from('payment_events')
    .select('tenant_id')
    .eq('stripe_payment_intent_id', paymentIntentId)
    .eq('status', 'succeeded')
    .not('tenant_id', 'is', null)
    .limit(1)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

async function tenantPorCharge(admin: any, chargeId: string): Promise<string | null> {
  const { data } = await admin.from('reversales_pago').select('tenant_id').eq('stripe_charge_id', chargeId).limit(1).maybeSingle();
  return data?.tenant_id ?? null;
}

const rpcOk = <T>(origen: string, r: { data: unknown; error: { message?: string; code?: string | null } | null }): T => {
  if (r.error) throw new ErrorRpcWebhook(origen, r.error);
  return r.data as T;
};

/** Ejecuta la acción de negocio. Lanza DivergenciaWebhook / ErrorRpcWebhook / errores de Stripe. */
async function ejecutarAccion(
  admin: any,
  stripe: ReturnType<typeof getStripe>,
  acctOpt: { stripeAccount: string } | undefined,
  stripeEvent: { id: string; type: string; created?: number },
  accion: Exclude<EventoClasificado, { kind: 'ignore' } | { kind: 'revision' }>,
  cuenta: { connectedAccount: string | null; tenantIdCuenta: string | null } = { connectedAccount: null, tenantIdCuenta: null }
): Promise<Efecto> {
  const ef: Efecto = { resultado: accion.kind, usuarioIdPago: null, membresiaIdPago: null, paqueteActivado: null, reportes: [] };

  if (accion.kind === 'activar') {
    // Mensual: leer la suscripción para el periodo_fin. Paquete (pago único):
    // no hay suscripción → periodo_fin lo decide activar_membresia por tipo.
    let periodoFin: string | null = null;
    if (accion.subscription_id) {
      const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
      periodoFin = periodoFinFromSubscription(sub);
    }
    const subsPrevias = await subsAnterioresDelSocio(admin, accion.usuario_id, accion.subscription_id);
    const act = rpcOk<{ idempotente?: boolean; membresia_id?: string | null; creditos?: number | null; periodo_fin?: string | null } | null>(
      'activar_membresia',
      await admin.rpc('activar_membresia', {
        p_usuario_id: accion.usuario_id,
        p_tier_id: accion.tier_id,
        p_stripe_subscription_id: accion.subscription_id,
        p_stripe_customer_id: accion.customer_id,
        p_periodo_fin: periodoFin,
        // Pago único: llave de idempotencia (la sesión de Checkout y su
        // PaymentIntent llegan como dos eventos del MISMO pago).
        p_referencia: accion.referencia
      })
    );
    ef.usuarioIdPago = accion.usuario_id;
    ef.membresiaIdPago = act?.membresia_id ?? null;
    ef.resultado = act?.idempotente ? 'activado:idempotente' : 'activado';
    // Segundo evento del mismo pago → ya se activó y ya se avisó: nada más que hacer.
    if (!act?.idempotente) {
      if (!accion.subscription_id) {
        ef.paqueteActivado = { creditos: act?.creditos ?? null, periodo_fin: act?.periodo_fin ?? null };
      }
      await cancelarSubsAnteriores(stripe, subsPrevias, acctOpt);
    }
    return ef;
  }

  if (accion.kind === 'activar-sub') {
    // Suscripción in-app (Elements): leer metadata + periodo de la suscripción,
    // sobre la cuenta conectada (Connect).
    const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
    const usuarioId = sub.metadata?.usuario_id;
    const tierId = sub.metadata?.tier_id;
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (!usuarioId || !tierId || !customerId) {
      // Se pagó la 1ª factura de una suscripción que no dice de quién es: dinero
      // sin derecho. Antes seguía como "procesado" en silencio.
      throw new DivergenciaWebhook('suscripcion_sin_metadata', `sub ${accion.subscription_id} sin usuario_id/tier_id/customer`);
    }
    const subsPrevias = await subsAnterioresDelSocio(admin, usuarioId, accion.subscription_id);
    const actSub = rpcOk<{ membresia_id?: string | null } | null>(
      'activar_membresia (sub)',
      await admin.rpc('activar_membresia', {
        p_usuario_id: usuarioId,
        p_tier_id: tierId,
        p_stripe_subscription_id: accion.subscription_id,
        p_stripe_customer_id: customerId,
        p_periodo_fin: periodoFinFromSubscription(sub)
      })
    );
    ef.usuarioIdPago = usuarioId;
    ef.membresiaIdPago = actSub?.membresia_id ?? null;
    ef.resultado = 'activado:sub';
    // #2: cancelar la(s) suscripción(es) anterior(es) en Stripe para que el
    // miembro NO quede pagando dos mensualidades tras un cambio de plan.
    await cancelarSubsAnteriores(stripe, subsPrevias, acctOpt);
    return ef;
  }

  if (accion.kind === 'sync') {
    // M5: las renovaciones (invoice.paid) llegan sin periodo_fin → leerlo de la
    // suscripción para EXTENDER la vigencia (si no, el perfil queda con la fecha
    // vieja aunque el cobro mensual haya entrado).
    let periodoFin = accion.periodo_fin;
    if (!periodoFin && accion.subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(accion.subscription_id, acctOpt);
        periodoFin = periodoFinFromSubscription(sub);
      } catch (e) {
        console.error('[stripe-webhook] periodo_fin de la sub', accion.subscription_id, e instanceof Error ? e.message : e);
      }
    }
    const resSync = rpcOk<{ success?: boolean; reason?: string; skipped?: string; ignorado?: string; conflicto?: boolean; membresia_id?: string } | null>(
      'sync_membresia_stripe',
      await admin.rpc('sync_membresia_stripe', {
        p_stripe_subscription_id: accion.subscription_id,
        p_estado: accion.estado,
        p_periodo_fin: periodoFin,
        p_cancel_at_period_end: accion.cancel_at_period_end,
        p_event_at: accion.event_at
      })
    );
    if (resSync?.success === false) {
      // PKG-01B · excepción ESTRICTA: `customer.subscription.updated` que deja la
      // suscripción `active` puede llegar antes que `invoice.paid` (Stripe no
      // ordena); la membresía aún no existe porque la CREA el evento financiero
      // (invoice.paid subscription_create → activar_membresia). No es divergencia:
      // no hay nada que aplicar. Si esa factura falla, su propia fila queda en
      // revisión. Cualquier otro caso sin membresía (past_due, pausada, cancelada,
      // facturas, deleted) sigue siendo divergencia.
      if (
        stripeEvent.type === 'customer.subscription.updated' &&
        accion.estado === 'activa' &&
        resSync.reason === 'membresia_no_encontrada'
      ) {
        ef.ignorar = 'sin_membresia:activacion_por_factura';
        ef.resultado = ef.ignorar;
        return ef;
      }
      // Divergencia: Stripe habla de una suscripción que localmente no existe.
      // Reintentar no la hace aparecer y no se inventa una membresía: revisión.
      throw new DivergenciaWebhook(resSync.reason ?? 'sync_sin_exito', `${stripeEvent.type} → ${accion.estado} sobre ${accion.subscription_id}`);
    }
    // Semántica R1 (sin cambios): evento viejo o membresía terminal → no aplica,
    // con motivo explícito. El conflicto queda en audit_log y se reporta.
    if (resSync?.conflicto) {
      ef.reportes.push({
        error: new Error(`sync_membresia_stripe: estado contradictorio (${stripeEvent.type} → ${accion.estado} sobre membresía terminal)`),
        extra: { event_id: stripeEvent.id, subscription_id: accion.subscription_id, membresia_id: resSync.membresia_id, clase: 'invariante' }
      });
      ef.resultado = 'sync:conflicto';
    } else if (resSync?.skipped) {
      ef.resultado = `sync:${resSync.skipped}`;
    } else if (resSync?.ignorado) {
      ef.resultado = `sync:${resSync.ignorado}`;
    } else {
      ef.resultado = `sync:${accion.estado}`;
    }
    return ef;
  }

  if (accion.kind === 'reversal') {
    // PKG-01G (D7=A, D8=A): evidencia durable con identidad (re_/dp_) + revisión
    // humana. CERO mutación de derechos: aquí no se llama a activar/sync/ajustar
    // créditos ni se toca usuarios/reservas/suscripciones. La atribución al
    // pago de origen la decide la RPC (único → enlaza; ninguno/ambiguo → revisión).
    const tenantId = cuenta.tenantIdCuenta ?? (await tenantPorPaymentIntent(admin, accion.payment_intent_id));
    if (!tenantId) {
      throw new DivergenciaWebhook('reversal_sin_tenant', `${accion.tipo} ${accion.object_id} sin estudio resoluble`);
    }
    const r = rpcOk<{ success?: boolean; reversal_id?: string; nuevo?: boolean; origen?: string; usuario_id?: string | null; estado_proveedor?: string } | null>(
      'registrar_reversal_pago',
      await admin.rpc('registrar_reversal_pago', {
        p_tipo: accion.tipo,
        p_stripe_object_id: accion.object_id,
        p_stripe_charge_id: accion.charge_id,
        p_stripe_payment_intent_id: accion.payment_intent_id,
        p_stripe_account: cuenta.connectedAccount,
        p_tenant_id: tenantId,
        p_monto_centavos: accion.amount,
        p_moneda: accion.currency,
        p_estado_proveedor: accion.estado,
        p_motivo_proveedor: accion.motivo,
        p_stripe_created_at: accion.object_created_at,
        p_evento_at: accion.event_at,
        p_stripe_event_id: stripeEvent.id,
        p_resumen: resumenEvento(stripeEvent as unknown as Parameters<typeof resumenEvento>[0])
      })
    );
    ef.usuarioIdPago = r?.usuario_id ?? null;
    ef.reversal = { tipo: accion.tipo, nuevo: r?.nuevo === true, estado: accion.estado, monto: accion.amount, moneda: accion.currency, origen: r?.origen ?? null, objectId: accion.object_id };
    ef.resultado = `${accion.tipo}:${r?.nuevo ? 'registrado' : 'actualizado'}:${accion.estado}`;
    return ef;
  }

  if (accion.kind === 'reconciliar-reembolso') {
    // charge.refunded: acumulado → solo se compara con los Refund registrados.
    // No crea monto. Si no cuadra, revisión 'reconciliacion_reembolso' (se
    // cierra sola cuando llegan los refund.* que faltan).
    const tenantId = cuenta.tenantIdCuenta ?? (await tenantPorCharge(admin, accion.charge_id));
    if (!tenantId) {
      ef.ignorar = 'reconciliacion_sin_tenant';
      ef.resultado = ef.ignorar;
      return ef;
    }
    const r = rpcOk<{ cuadra?: boolean; suma_centavos?: number } | null>(
      'reconciliar_reembolsos_cargo',
      await admin.rpc('reconciliar_reembolsos_cargo', {
        p_tenant_id: tenantId,
        p_stripe_charge_id: accion.charge_id,
        p_amount_refunded: accion.amount_refunded,
        p_stripe_event_id: stripeEvent.id
      })
    );
    ef.resultado = r?.cuadra ? 'reconciliacion:cuadra' : 'reconciliacion:pendiente';
    return ef;
  }

  if (accion.kind === 'cuenta-desautorizada') {
    // D-01G-3: apaga el gate de cobro del estudio y conserva stripe_account_id.
    // No toca membresías ni suscripciones.
    if (!cuenta.connectedAccount) {
      throw new DivergenciaWebhook('deauthorized_sin_cuenta', 'account.application.deauthorized sin event.account');
    }
    const r = rpcOk<{ success?: boolean; reason?: string; idempotente?: boolean; tenant_id?: string } | null>(
      'marcar_cuenta_desautorizada',
      await admin.rpc('marcar_cuenta_desautorizada', {
        p_stripe_account: cuenta.connectedAccount,
        p_stripe_event_id: stripeEvent.id,
        p_evento_at: accion.event_at
      })
    );
    if (r?.success === false) {
      throw new DivergenciaWebhook(r.reason ?? 'cuenta_no_encontrada', `cuenta ${cuenta.connectedAccount}`);
    }
    ef.cuentaDesautorizada = r?.idempotente ? null : { tenantId: r?.tenant_id ?? cuenta.tenantIdCuenta ?? '' };
    ef.resultado = r?.idempotente ? 'cuenta:desautorizada:idempotente' : 'cuenta:desautorizada';
    return ef;
  }

  if (accion.kind === 'cuenta-conectada') {
    // account.updated → refrescar el gate de cobro del estudio (antes solo lo
    // hacía connect-status cuando el admin abría /admin/cobros).
    const { error } = await admin
      .from('tenants')
      .update({
        stripe_charges_enabled: accion.charges_enabled,
        stripe_details_submitted: accion.details_submitted
      })
      .eq('stripe_account_id', accion.account_id);
    if (error) throw new ErrorRpcWebhook('tenants.update (account.updated)', error);
    ef.resultado = 'cuenta:actualizada';
    return ef;
  }

  // invitados-extra (PKG-01H): aplicar UNA vez por PaymentIntent, validando en
  // servidor estado/fecha/tenant/cuenta/tope/monto. Un pago que no puede aplicarse
  // queda como evidencia `no_aplicado` + revisión financiera (W-2=A): el evento se
  // da por procesado (la discrepancia ya es durable) y se avisa a los admins.
  if (!cuenta.connectedAccount || !cuenta.tenantIdCuenta) {
    throw new DivergenciaWebhook('invitados_extra_sin_cuenta', `PI ${accion.payment_intent_id} sin cuenta conectada resoluble`);
  }
  const r = rpcOk<{ success?: boolean; reason?: string; estado?: string; motivo?: string | null; idempotente?: boolean; revision_creada?: boolean } | null>(
    'aplicar_invitados_extra_pago',
    await admin.rpc('aplicar_invitados_extra_pago', {
      p_payment_intent_id: accion.payment_intent_id,
      p_stripe_account: cuenta.connectedAccount,
      p_tenant_id: cuenta.tenantIdCuenta,
      p_stripe_event_id: stripeEvent.id,
      p_reserva_id: accion.reserva_id,
      p_usuario_id: accion.usuario_id,
      p_cantidad: accion.cantidad,
      p_monto_centavos: accion.monto_centavos,
      p_precio_unitario_centavos: accion.precio_unitario_centavos,
      p_moneda: accion.moneda,
      p_pagado_at: accion.event_at,
      // Se coteja contra el tenant de la cuenta del evento (no es autoridad).
      p_tenant_id_metadata: accion.tenant_id_metadata && /^[0-9a-f-]{36}$/i.test(accion.tenant_id_metadata) ? accion.tenant_id_metadata : null
    })
  );
  if (r?.success === false) {
    // Reserva inexistente: no hay a qué atar la evidencia → revisión 01A.
    throw new DivergenciaWebhook(r.reason ?? 'invitados_extra_sin_reserva', `PI ${accion.payment_intent_id} → reserva ${accion.reserva_id}`);
  }
  ef.usuarioIdPago = accion.usuario_id;
  if (r?.estado === 'aplicado') {
    ef.resultado = r.idempotente ? 'invitados_extra:idempotente' : 'invitados_extra:aplicado';
  } else {
    ef.resultado = `invitados_extra:no_aplicado:${r?.motivo ?? 'desconocido'}${r?.idempotente ? ':idempotente' : ''}`;
    if (!r?.idempotente) {
      ef.extrasNoAplicados = { tenantId: cuenta.tenantIdCuenta, motivo: r?.motivo ?? 'desconocido', paymentIntentId: accion.payment_intent_id, cantidad: accion.cantidad, monto: accion.monto_centavos, moneda: accion.moneda };
    }
  }
  return ef;
}

/**
 * Diario de cobranza (`payment_events`). Se VERIFICA: si falla, el evento no se
 * da por procesado (lanza → error_reintentable → Stripe reintenta; la re-entrada
 * es segura porque el efecto es idempotente y el diario tiene UNIQUE por evento).
 * Devuelve los datos resueltos para los avisos.
 */
async function registrarDiario(
  admin: any,
  stripeEvent: { id: string; type: string },
  monto: MontoEvento,
  ef: Efecto
): Promise<{ tenantIdPago: string | null; usuarioIdPago: string | null }> {
  let usuarioIdPago = ef.usuarioIdPago;
  let membresiaIdPago = ef.membresiaIdPago;
  let tenantIdPago: string | null = null;
  // Renovación (sync) o activación por suscripción: resolver membresía,
  // usuario y tenant por la suscripción (determinista: la suscripción es de
  // una sola membresía). Sin coincidencia → sin atribución (no se adivina).
  if (monto.stripe_subscription_id && (!usuarioIdPago || !membresiaIdPago)) {
    const { data: mem } = await admin
      .from('membresias')
      .select('id, usuario_id, tenant_id')
      .eq('stripe_subscription_id', monto.stripe_subscription_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (mem && (!usuarioIdPago || mem.usuario_id === usuarioIdPago)) {
      usuarioIdPago = mem.usuario_id ?? null;
      tenantIdPago = mem.tenant_id ?? null;
      membresiaIdPago = membresiaIdPago ?? mem.id ?? null;
    }
  }
  if (usuarioIdPago && !tenantIdPago) {
    const { data: u } = await admin.from('usuarios').select('tenant_id').eq('id', usuarioIdPago).maybeSingle();
    tenantIdPago = u?.tenant_id ?? null;
  }
  const { error } = await admin.from('payment_events').upsert(
    {
      stripe_event_id: stripeEvent.id,
      stripe_event_type: stripeEvent.type,
      tenant_id: tenantIdPago,
      usuario_id: usuarioIdPago,
      membresia_id: membresiaIdPago,
      monto_centavos: monto.monto_centavos,
      moneda: monto.moneda,
      status: monto.status,
      stripe_invoice_id: monto.stripe_invoice_id,
      stripe_payment_intent_id: monto.stripe_payment_intent_id,
      stripe_subscription_id: monto.stripe_subscription_id,
      stripe_customer_id: monto.stripe_customer_id,
      // Evidencia sin PII (PKG-01A): ids, montos y estructura; nunca correo,
      // nombre ni dirección. Solo eventos nuevos; la historia no se toca.
      raw_payload: redactarPayload(stripeEvent as unknown as Record<string, unknown>),
      processed_at: new Date().toISOString()
    },
    { onConflict: 'stripe_event_id', ignoreDuplicates: true }
  );
  if (error) throw new ErrorRpcWebhook('payment_events.upsert', error);

  // PKG-01G · vínculos tardíos DENTRO del paso verificado (HARDENING B): si
  // fallan, el evento queda `error_reintentable` y Stripe reintenta (ambas RPC
  // son idempotentes). Y aunque nunca corrieran, lo pendiente es consultable:
  // reversales sin origen (+ revisión 'origen_no_resuelto') y la vista
  // `movimientos_sin_vinculo`.
  if (monto.status === 'succeeded') {
    if (monto.stripe_payment_intent_id) {
      rpcOk('reatribuir_reversales', await admin.rpc('reatribuir_reversales', { p_stripe_payment_intent_id: monto.stripe_payment_intent_id }));
    }
    if (membresiaIdPago) {
      const { data: pe } = await admin.from('payment_events').select('id').eq('stripe_event_id', stripeEvent.id).maybeSingle();
      if (pe?.id) {
        rpcOk('vincular_origen_valor', await admin.rpc('vincular_origen_valor', { p_membresia_id: membresiaIdPago, p_payment_event_id: pe.id }));
      }
    }
  }
  return { tenantIdPago, usuarioIdPago };
}

/**
 * Avisos al miembro/equipo y correos. BEST-EFFORT y después de `procesado`:
 * un correo que falla no debe hacer que Stripe reintente la acción de dinero.
 */
async function avisos(
  admin: any,
  stripeEvent: { id: string; type: string; data: { object: unknown } },
  monto: MontoEvento,
  ids: { tenantIdPago: string | null; usuarioIdPago: string | null },
  paqueteActivado: Efecto['paqueteActivado']
): Promise<void> {
  const { tenantIdPago, usuarioIdPago } = ids;
  if (!usuarioIdPago) return;
  const { data: u } = await admin.from('usuarios').select('email, nombre').eq('id', usuarioIdPago).maybeSingle();
  const email = u?.email ?? null;
  const dinero = (monto.monto_centavos / 100).toLocaleString('es-MX', { style: 'currency', currency: monto.moneda.toUpperCase() });

  // Pago fallido → aviso IN-APP al miembro (cron-push lo lleva al teléfono)
  // + aviso al equipo + email. No dependen de que haya email ni de Resend.
  if (monto.status === 'failed' && tenantIdPago) {
    await admin.from('notificaciones').insert({
      tenant_id: tenantIdPago,
      usuario_id: usuarioIdPago,
      tipo: 'pago_rechazado',
      titulo: 'No pudimos cobrar tu membresía',
      mensaje: `Tu tarjeta rechazó el cobro de ${dinero}. Actualízala en tu perfil para no perder tu acceso.`,
      metadata: { stripe_invoice_id: monto.stripe_invoice_id, url: '/app/perfil' }
    });
    // El equipo también debe enterarse: dunning en mostrador.
    await avisarStaff(admin, {
      tenant_id: tenantIdPago,
      tipo: 'cobro_rechazado',
      titulo: 'Cobro rechazado',
      mensaje: `La tarjeta de ${u?.nombre ?? email ?? 'un miembro'} rechazó el cobro de ${dinero}. Stripe reintentará; si no, pídele que actualice su tarjeta.`,
      metadata: { usuario_id: usuarioIdPago, stripe_invoice_id: monto.stripe_invoice_id },
      url: `/admin/miembros/${usuarioIdPago}`
    });
  }

  // Identidad del estudio (logo, nombre, contacto) desde Administración.
  let tenantFila: { nombre?: unknown; branding?: unknown; config?: unknown } | null = null;
  if (tenantIdPago) {
    const { data: t } = await admin.from('tenants').select('nombre, branding, config').eq('id', tenantIdPago).maybeSingle();
    tenantFila = t ?? null;
  }
  const estudio = identidadEstudio(tenantFila);
  const base = { estudio, nombre: u?.nombre ?? null, montoCentavos: monto.monto_centavos, moneda: monto.moneda };
  let tpl: EmailRenderizado | null = null;
  if (monto.status === 'failed') {
    tpl = emailPagoFallido(base);
  } else if (monto.status === 'succeeded' && stripeEvent.type === 'invoice.paid') {
    const inv = stripeEvent.data.object as { billing_reason?: string };
    tpl = inv?.billing_reason === 'subscription_create' ? emailBienvenida(base) : emailRecibo(base);
  } else if (monto.status === 'succeeded' && paqueteActivado) {
    tpl = emailPaqueteComprado({ ...base, creditos: paqueteActivado.creditos, venceEl: paqueteActivado.periodo_fin });
  }
  // PKG-00F: identidad determinista (evento Stripe + plantilla) → Resend descarta
  // el duplicado si el evento se reprocesa. PKG-03A: el resultado queda como
  // evidencia en `correos_directos` (misma llave; sin destinatario ni cuerpo).
  // Nunca se actúa sobre el dinero: ya quedó.
  if (!tpl) return;
  const idempotencyKey = `ekko:email:stripe:${stripeEvent.id}:${tpl.plantilla}`;
  let registro: { resultado: 'aceptado' | 'sin_correo' | 'fallo'; proveedorId: string | null; error: string | null };
  if (!email) {
    registro = { resultado: 'sin_correo', proveedorId: null, error: null };
  } else {
    const r = await enviarEmail({
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      plantilla: tpl.plantilla,
      idempotencyKey,
      ref: stripeEvent.id
    });
    if (r.estado === 'no_configurado') return; // sin proveedor: no hubo intento que asentar
    registro = r.estado === 'aceptado'
      ? { resultado: 'aceptado', proveedorId: r.id, error: null }
      : { resultado: 'fallo', proveedorId: null, error: motivoPersistible(r) };
  }
  if (!tenantIdPago) return; // sin estudio no hay a quién mostrárselo
  const { error: errReg } = await admin.rpc('registrar_correo_directo', {
    p_key: idempotencyKey,
    p_tenant_id: tenantIdPago,
    p_usuario_id: usuarioIdPago,
    p_plantilla: tpl.plantilla,
    p_stripe_event_id: stripeEvent.id,
    p_resultado: registro.resultado,
    p_proveedor_id: registro.proveedorId,
    p_error: registro.error
  });
  if (errReg) console.error('[stripe-webhook] correo directo sin evidencia', errReg.message);
}

/**
 * PKG-01G · Avisos a ADMINS (nunca a recepción ni al miembro) cuando se registra
 * un reembolso o disputa nuevos, cuando una disputa se pierde, o cuando el
 * estudio desautorizó Connect. Best-effort, después de `procesado`. El enlace
 * lleva a la lista de revisiones en /admin/cobros.
 */
async function avisosReversal(admin: any, ef: Efecto, tenantIdCuenta: string | null): Promise<void> {
  if (ef.reversal) {
    const r = ef.reversal;
    const dinero = (r.monto / 100).toLocaleString('es-MX', { style: 'currency', currency: r.moneda.toUpperCase() });
    let tenantId = tenantIdCuenta;
    if (!tenantId) {
      const { data } = await admin.from('reversales_pago').select('tenant_id').eq('stripe_object_id', r.objectId).maybeSingle();
      tenantId = data?.tenant_id ?? null;
    }
    if (!tenantId) return;
    const perdida = r.tipo === 'disputa' && r.estado === 'lost';
    if (!r.nuevo && !perdida) return; // actualizaciones intermedias no avisan
    const titulo = r.tipo === 'reembolso' ? 'Reembolso en Stripe' : perdida ? 'Disputa perdida en Stripe' : 'Disputa abierta en Stripe';
    const mensaje =
      r.tipo === 'reembolso'
        ? `Stripe registró un reembolso de ${dinero}. Revisa el caso: el sistema no quita créditos ni cancela membresías por su cuenta.`
        : perdida
          ? `Se perdió una disputa por ${dinero}. Revisa el caso: el sistema no quita créditos ni cancela membresías por su cuenta.`
          : `Un miembro disputó un cobro de ${dinero}. Su acceso sigue igual mientras se resuelve; revisa el caso.`;
    await avisarStaff(admin, {
      tenant_id: tenantId,
      tipo: r.tipo === 'reembolso' ? 'reembolso' : 'disputa',
      titulo,
      mensaje,
      metadata: { stripe_object_id: r.objectId, origen: r.origen, usuario_id: ef.usuarioIdPago },
      url: '/admin/cobros',
      soloAdmins: true
    });
  }
  if (ef.extrasNoAplicados) {
    const x = ef.extrasNoAplicados;
    const dinero = (x.monto / 100).toLocaleString('es-MX', { style: 'currency', currency: x.moneda.toUpperCase() });
    await avisarStaff(admin, {
      tenant_id: x.tenantId,
      tipo: 'invitados_extra_no_aplicado',
      titulo: 'Pago de invitados extra sin aplicar',
      mensaje: `Un miembro pagó ${dinero} por ${x.cantidad} invitado${x.cantidad === 1 ? '' : 's'} extra, pero no se pudo aplicar a su reserva. Revisa el caso en Cobros: el sistema no reembolsa solo.`,
      metadata: { stripe_payment_intent_id: x.paymentIntentId, motivo: x.motivo, usuario_id: ef.usuarioIdPago },
      url: '/admin/cobros',
      soloAdmins: true
    });
  }
  if (ef.cuentaDesautorizada?.tenantId) {
    await avisarStaff(admin, {
      tenant_id: ef.cuentaDesautorizada.tenantId,
      tipo: 'stripe_desconectado',
      titulo: 'Cobros desconectados de Stripe',
      mensaje: 'El estudio desautorizó la conexión con Stripe. No se pueden iniciar cobros nuevos hasta reconectar en Cobros. Las membresías vigentes no cambian.',
      metadata: {},
      url: '/admin/cobros',
      soloAdmins: true
    });
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  // Webhook de Connect: el signing secret es el del endpoint de Connect
  // (STRIPE_CONNECT_WEBHOOK_SECRET); cae al genérico por compatibilidad.
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    // Antes respondía 200 "skipped": Stripe daba el evento por entregado y se
    // perdía. Sin configuración no hay forma de verificar ni procesar → 5xx
    // para que Stripe lo conserve y reintente cuando alguien lo arregle.
    await reportarErrorServidor('stripe-webhook', new Error('stripe_no_configurado: falta el secret del webhook o STRIPE_SECRET_KEY'), { clase: 'configuracion' });
    return serverError('stripe_no_configurado');
  }

  const stripe = getStripe();
  const sig = event.headers['stripe-signature'];
  if (!sig) return badRequest('Falta stripe-signature');

  // Body crudo: Netlify puede entregarlo en base64.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] firma inválida', err);
    return badRequest('Firma inválida');
  }

  const admin = createClient(
    requireEnv('VITE_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );

  // ── Cuenta ajena: la cuenta Stripe de la plataforma se comparte con otros
  //    productos (SALA, HSC). Un evento de una cuenta conectada que no es de
  //    ningún estudio de EKKO se responde 200 y se descarta SIN fila (regla
  //    explícita; la tabla solo guarda eventos de EKKO).
  const connectedAccount = (stripeEvent as unknown as { account?: string }).account ?? null;
  let tenantIdCuenta: string | null = null;
  if (connectedAccount) {
    const { data: tenantDeCuenta, error: tenantErr } = await admin
      .from('tenants')
      .select('id')
      .eq('stripe_account_id', connectedAccount)
      .maybeSingle();
    if (tenantErr) {
      console.error('[stripe-webhook] lookup tenant por cuenta', tenantErr.message);
      return serverError('No se pudo resolver la cuenta conectada');
    }
    if (!tenantDeCuenta) return ok({ received: true, ignored: 'cuenta_ajena' });
    tenantIdCuenta = tenantDeCuenta.id as string;
  }

  // ── Reclamación atómica: un event.id → una sola ejecución activa ──────────
  const { data: claimData, error: claimErr } = await admin.rpc('claim_stripe_event', {
    p_id: stripeEvent.id,
    p_type: stripeEvent.type,
    p_stripe_account: connectedAccount,
    p_livemode: stripeEvent.livemode ?? null,
    p_event_created_at: stripeEvent.created ? new Date(stripeEvent.created * 1000).toISOString() : null,
    p_api_version: stripeEvent.api_version ?? null,
    p_resumen: resumenEvento(stripeEvent),
    p_lease_segundos: LEASE_SEGUNDOS
  });
  if (claimErr || !claimData) {
    // Sin reclamación no hay evidencia durable: nunca 200.
    await reportarErrorServidor('stripe-webhook', new ErrorRpcWebhook('claim_stripe_event', claimErr ?? { message: 'sin respuesta' }), { event_id: stripeEvent.id, type: stripeEvent.type, clase: 'reintentable' });
    return serverError('No se pudo registrar el evento');
  }
  const claim = claimData as Claim;
  if (claim.resultado === 'duplicado') return ok({ received: true, duplicate: true });
  if (claim.resultado === 'en_curso') {
    // Otro intento lo está procesando ahora mismo. 503 → Stripe reintenta más
    // tarde: para entonces estará terminado (duplicate) o será reclamable.
    return respuesta(503, { retry: 'en_curso' });
  }

  // Connect: las lecturas a Stripe (retrieve de la suscripción) deben ir sobre
  // la cuenta conectada del evento.
  const acctOpt = connectedAccount ? { stripeAccount: connectedAccount } : undefined;
  const accion = clasificarEvento(stripeEvent);
  const contexto = { event_id: stripeEvent.id, type: stripeEvent.type, account: connectedAccount, intentos: claim.intentos };

  /** Cierra en `revision` (200): fila + evidencia + aviso + reporte; una re-entrega vuelve a reclamar. */
  const aRevision = async (motivo: string, ultimoError: string | null): Promise<HandlerResponse> => {
    try {
      await finalizar(admin, stripeEvent.id, 'revision', { accion: accion.kind, motivo, ultimo_error: ultimoError });
    } catch (finErr) {
      await reportarErrorServidor('stripe-webhook', finErr, { ...contexto, clase: 'reintentable', al_finalizar: 'revision' });
      return serverError('No se pudo registrar la revisión del evento');
    }
    await reportarErrorServidor('stripe-webhook', new Error(`revision: ${motivo}${ultimoError ? ` — ${ultimoError}` : ''}`), { ...contexto, clase: 'revision', motivo });
    await avisarRevision(admin, stripeEvent, motivo, tenantIdCuenta);
    return ok({ received: true, revision: motivo });
  };

  // Reclamo de un lease vencido: la ejecución anterior murió a medias. Si la
  // acción NO es idempotente (invitados extra), pudo haberse aplicado ya: no se
  // repite; a revisión con motivo.
  if (claim.resultado === 'reclamado' && claim.estado_previo === 'en_proceso' && !accionIdempotente(accion.kind)) {
    return aRevision('reentrada_sobre_efecto_no_idempotente', `acción ${accion.kind} reclamada tras lease vencido (intento ${claim.intentos})`);
  }

  if (accion.kind === 'ignore') {
    try {
      await finalizar(admin, stripeEvent.id, 'ignorado', { accion: 'ignore', motivo: accion.reason });
    } catch (finErr) {
      await reportarErrorServidor('stripe-webhook', finErr, { ...contexto, clase: 'reintentable', al_finalizar: 'ignorado' });
      return serverError('No se pudo registrar el evento ignorado');
    }
    return ok({ received: true, ignored: accion.reason });
  }

  if (accion.kind === 'revision') {
    return aRevision(accion.motivo, null);
  }

  try {
    const ef = await ejecutarAccion(admin, stripe, acctOpt, stripeEvent, accion, { connectedAccount, tenantIdCuenta });

    if (ef.ignorar) {
      await finalizar(admin, stripeEvent.id, 'ignorado', { accion: accion.kind, motivo: ef.ignorar });
      return ok({ received: true, ignored: ef.ignorar });
    }

    // ── Diario de cobranza (verificado) ANTES de dar el evento por procesado ─
    const monto = extraerMontoDeEvento(stripeEvent);
    const ids = monto ? await registrarDiario(admin, stripeEvent, monto, ef) : null;

    await finalizar(admin, stripeEvent.id, 'procesado', { accion: accion.kind, motivo: ef.resultado });

    for (const r of ef.reportes) await reportarErrorServidor('stripe-webhook', r.error, r.extra);

    // ── Avisos (best-effort, después de procesado) ────────────────────────
    if (monto && ids) {
      try {
        await avisos(admin, stripeEvent, monto, ids, ef.paqueteActivado);
      } catch (avisoErr) {
        console.error('[stripe-webhook] avisos/email', avisoErr);
      }
    }
    // PKG-01G: avisos a admins por reversal nuevo / disputa perdida / cuenta desautorizada.
    try {
      await avisosReversal(admin, ef, tenantIdCuenta);
    } catch (avisoErr) {
      console.error('[stripe-webhook] avisos reversal', avisoErr);
    }
    return ok({ received: true });
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    const clase = clasificarError(err);
    if (clase === 'permanente') {
      return aRevision(err instanceof DivergenciaWebhook ? err.motivo : 'error_permanente', mensaje);
    }
    if (claim.intentos >= MAX_INTENTOS) {
      return aRevision('intentos_agotados', mensaje);
    }
    // Transitorio: la fila queda en error_reintentable con el error; Stripe
    // reintenta y el siguiente intento la reclama. La fila NUNCA se borra.
    try {
      await finalizar(admin, stripeEvent.id, 'error_reintentable', { accion: accion.kind, ultimo_error: mensaje });
    } catch (finErr) {
      await reportarErrorServidor('stripe-webhook', finErr, { ...contexto, clase: 'reintentable', al_finalizar: 'error_reintentable' });
    }
    await reportarErrorServidor('stripe-webhook', err, { ...contexto, clase: 'reintentable' });
    return serverError(mensaje || 'webhook error');
  }
};
