import type { SupabaseClient } from '@supabase/supabase-js';
import { getStripe } from './stripe';
import { resolverCuentaConectada } from './connectBilling';
import { reportarErrorServidor } from './sentry';

/**
 * R2-B (PKG-01P) · Ejecutor de las operaciones de cobro en Stripe.
 *
 * La base decide QUÉ debe pasar en Stripe y lo deja en
 * `stripe_operaciones_suscripcion`, en la misma transacción que la sanción, la
 * revocación o la baja:
 *   suspender_cobro      sanción            → pause_collection { behavior: 'void' }
 *   reanudar_cobro       sanción levantada  → pause_collection: null
 *   cancelar_suscripcion revocación / baja  → subscriptions.cancel (inmediata)
 *   PKG-02H · también las operaciones del STAFF (pausa, reactivación, baja al fin
 *   del periodo): suspender_cobro/reanudar_cobro con causa pausa_staff /
 *   reactivacion_staff, y cancelar_fin_periodo → cancel_at_period_end: true.
 *   PKG-06B · también lo que pide el MIEMBRO (baja o reactivación al fin del
 *   periodo: reanudar_renovacion → cancel_at_period_end: false) y la cancelación
 *   de la suscripción ANTERIOR que registra el webhook. `cambiar_plan` NUNCA pasa
 *   por aquí: lo ejecuta el propio flujo del miembro.
 *
 * Aquí solo se EJECUTA y se asienta el resultado:
 *   1) `operacion_suscripcion_preparar` revalida contra el estado actual (no se
 *      reanuda una cuenta revocada ni una membresía cancelada) y entrega la
 *      llave de idempotencia de ESTA operación y ESTE intento;
 *   2) se llama a Stripe con esa llave;
 *   3) `operacion_suscripcion_resultado` deja `aplicada` o `fallida`.
 * Un fallo NO deshace nada en EKKO: la fila queda `fallida`, el admin recibe un
 * aviso y el cron diario (o el siguiente disparo) la reintenta. Sin reembolsos.
 */

/** PKG-06B: lo que este ejecutor aplica en Stripe. `cambiar_plan` queda fuera a propósito. */
export const TIPOS_EJECUTABLES = ['suspender_cobro', 'reanudar_cobro', 'cancelar_suscripcion', 'cancelar_fin_periodo', 'reanudar_renovacion'];

export interface ResumenOperaciones {
  procesadas: number;
  aplicadas: number;
  fallidas: number;
  descartadas: number;
  /** Stripe no está configurado en este entorno: las operaciones quedan pendientes. */
  sin_stripe: boolean;
}

interface Preparada {
  ejecutar: boolean;
  estado?: string;
  motivo?: string;
  tipo?: 'suspender_cobro' | 'reanudar_cobro' | 'cancelar_suscripcion' | 'cancelar_fin_periodo' | 'reanudar_renovacion';
  tenant_id?: string;
  stripe_subscription_id?: string;
  idempotency_key?: string;
}

/** `cancel` sobre una suscripción que ya no existe o ya está cancelada = ya aplicada. */
function yaCancelada(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  const msg = (err?.message ?? '').toLowerCase();
  return err?.code === 'resource_missing' || msg.includes('no such subscription') || msg.includes('canceled subscription');
}

/** Tipo y código del error del proveedor; el mensaje se recorta. Sin PII ni secretos. */
export function describirErrorProveedor(e: unknown): string {
  const err = e as { type?: string; code?: string; message?: string } | null;
  const partes = [err?.type ?? 'error', err?.code ?? '', (err?.message ?? String(e)).slice(0, 160)];
  return partes.filter(Boolean).join(':');
}

export async function ejecutarOperacionesSuscripcion(
  admin: SupabaseClient,
  filtro: { usuarioId?: string; limite?: number } = {}
): Promise<ResumenOperaciones> {
  const resumen: ResumenOperaciones = { procesadas: 0, aplicadas: 0, fallidas: 0, descartadas: 0, sin_stripe: false };
  if (!process.env.STRIPE_SECRET_KEY) return { ...resumen, sin_stripe: true };

  let consulta = admin
    .from('stripe_operaciones_suscripcion')
    .select('id')
    .in('estado', ['pendiente', 'fallida'])
    // PKG-06B: solo los tipos que este ejecutor sabe aplicar (el cambio de plan no).
    .in('tipo', TIPOS_EJECUTABLES)
    // PKG-03A: agotada (5 intentos en la ronda) = necesita a un humano en Operación.
    .is('reintentos_agotados_at', null)
    .order('created_at', { ascending: true })
    .limit(filtro.limite ?? 25);
  if (filtro.usuarioId) consulta = consulta.eq('usuario_id', filtro.usuarioId);
  const { data, error } = await consulta;
  if (error) throw new Error(`stripe_operaciones_suscripcion: ${error.message}`);

  const filas = (data ?? []) as Array<{ id: string }>;
  if (filas.length === 0) return resumen;

  const stripe = getStripe();
  const cuentaPorTenant = new Map<string, string | null>();

  for (const fila of filas) {
    const { data: prepData, error: prepErr } = await admin.rpc('operacion_suscripcion_preparar', { p_id: fila.id });
    if (prepErr) {
      await reportarErrorServidor('operaciones-suscripcion', new Error(prepErr.message), { paso: 'preparar', operacion_id: fila.id });
      continue;
    }
    const prep = (prepData ?? { ejecutar: false }) as Preparada;
    resumen.procesadas++;
    if (!prep.ejecutar || !prep.tipo || !prep.tenant_id || !prep.stripe_subscription_id) {
      if (prep.estado === 'descartada') resumen.descartadas++;
      continue;
    }

    let aplicada = false;
    let errorProveedor: string | null = null;
    let resultado: Record<string, unknown> = {};
    try {
      let accountId = cuentaPorTenant.get(prep.tenant_id);
      if (accountId === undefined) {
        accountId = (await resolverCuentaConectada(admin, prep.tenant_id)).accountId;
        cuentaPorTenant.set(prep.tenant_id, accountId);
      }
      if (!accountId) throw Object.assign(new Error('El estudio no tiene cuenta de Stripe conectada'), { type: 'ekko', code: 'cuenta_conectada_no_resuelta' });

      const opciones = { stripeAccount: accountId, idempotencyKey: prep.idempotency_key };
      const subId = prep.stripe_subscription_id;
      if (prep.tipo === 'cancelar_suscripcion') {
        const sub = await stripe.subscriptions.cancel(subId, opciones);
        resultado = { status: sub?.status ?? 'canceled' };
      } else if (prep.tipo === 'cancelar_fin_periodo' || prep.tipo === 'reanudar_renovacion') {
        const cancelar = prep.tipo === 'cancelar_fin_periodo';
        const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: cancelar }, opciones);
        resultado = { status: sub?.status ?? null, cancel_at_period_end: sub?.cancel_at_period_end ?? cancelar };
      } else if (prep.tipo === 'suspender_cobro' || prep.tipo === 'reanudar_cobro') {
        const sub = await stripe.subscriptions.update(
          subId,
          { pause_collection: prep.tipo === 'suspender_cobro' ? { behavior: 'void' as const } : null },
          opciones
        );
        resultado = { status: sub?.status ?? null, pause_collection: sub?.pause_collection?.behavior ?? null };
      } else {
        // PKG-06B: un tipo que este ejecutor no conoce jamás se traduce en otra llamada.
        throw Object.assign(new Error(`tipo no ejecutable: ${String(prep.tipo)}`), { type: 'ekko', code: 'tipo_no_ejecutable' });
      }
      aplicada = true;
    } catch (e) {
      if ((prep.tipo === 'cancelar_suscripcion' || prep.tipo === 'cancelar_fin_periodo') && yaCancelada(e)) {
        aplicada = true;
        resultado = { status: 'canceled', nota: 'ya_estaba_cancelada' };
      } else {
        errorProveedor = describirErrorProveedor(e);
      }
    }

    const { error: resErr } = await admin.rpc('operacion_suscripcion_resultado', {
      p_id: fila.id,
      p_ok: aplicada,
      p_error: errorProveedor,
      p_resultado: resultado
    });
    if (resErr) {
      await reportarErrorServidor('operaciones-suscripcion', new Error(resErr.message), { paso: 'resultado', operacion_id: fila.id, aplicada });
    }
    if (aplicada) {
      resumen.aplicadas++;
    } else {
      resumen.fallidas++;
      await reportarErrorServidor('operaciones-suscripcion', new Error(errorProveedor ?? 'error_desconocido'), {
        operacion_id: fila.id,
        tipo: prep.tipo,
        nota: 'El cambio en EKKO sigue vigente; la operación queda fallida y se reintenta.'
      });
    }
  }
  return resumen;
}
