import type Stripe from 'stripe';
import { llavePrecio } from './stripe';
import {
  llaveOperacion,
  llaveInvalidacion,
  ejecutarOperacion,
  clasificarPaymentIntent,
  clasificarSuscripcion,
  evidenciaPagoInicial,
  porOperacion,
  registrarOperacion,
  crearSesionCliente,
  PresupuestoAgotado,
  type Presupuesto,
  type KindOperacion,
  type ResultadoOperacion
} from './operacionPago';

/**
 * PKG-01E · Preparar el pago de un PLAN (paquete → PaymentIntent; mensual →
 * suscripción `default_incomplete`) para un MIEMBRO dado, con las garantías de
 * 01C: key estable `ekko:v1:<kind>:<acct>:<miembro>:<operation_id>`, búsqueda
 * previa por operación dentro del customer del miembro, clasificación por
 * estado observable, cancel por drift, presupuesto de tiempo.
 *
 * La identidad de la operación es (cuenta, miembro, operation_id): el mismo
 * UUID usado para otro miembro es OTRA identidad (otra key, otro customer) y
 * nunca adopta el objeto del primero. El importe se deriva del catálogo aquí;
 * el cliente no manda montos. Nada de esto concede entitlement: lo hace el
 * webhook (01A/01B → R1).
 */

export interface TierPlan {
  id: string;
  slug: string;
  nombre: string;
  precio_centavos: number;
  moneda: string | null;
  tipo: string;
}

export interface PreparacionPlan {
  stripe: Stripe;
  presupuesto: Presupuesto;
  accountId: string;
  customerId: string;
  /** Miembro que RECIBE el plan (dueño del customer y de la key). */
  miembroId: string;
  tier: TierPlan;
  feePct: number;
  operationId: string;
  /** Metadata adicional sin PII (p. ej. origen y actor de mostrador). */
  metadataExtra?: Record<string, string>;
  /** Etiqueta de la función para logs. */
  funcion: string;
}

export type RespuestaPreparacion = Record<string, unknown> & { estado: string; operationId: string };

export function esPaquete(tier: Pick<TierPlan, 'tipo'>): boolean {
  return tier.tipo === 'creditos' || tier.tipo === 'hibrido';
}

export function secretoPrimeraFactura(sub: Stripe.Subscription): string | null {
  const inv = sub.latest_invoice as unknown as {
    payment_intent?: { client_secret?: string } | string | null;
    confirmation_secret?: { client_secret?: string } | null;
  } | null;
  if (!inv || typeof inv !== 'object') return null;
  const pi = typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  return inv.confirmation_secret?.client_secret ?? pi?.client_secret ?? null;
}

export async function prepararPagoPlan(p: PreparacionPlan): Promise<RespuestaPreparacion> {
  const { stripe, presupuesto, accountId, customerId, miembroId, tier, feePct, operationId } = p;
  const opt = { stripeAccount: accountId };
  const currency = (tier.moneda || 'mxn').toLowerCase();
  const paquete = esPaquete(tier);
  const kind: KindOperacion = paquete ? 'pi_paquete' : 'sub_mensual';
  const target = `${paquete ? 'paquete' : 'mensual'}:${tier.id}`;
  const key = llaveOperacion(kind, accountId, miembroId, operationId);
  const metadata = { app: 'ekko', usuario_id: miembroId, tier_id: tier.id, operation_id: operationId, ekko_target: target, ...(p.metadataExtra ?? {}) };
  const amount = tier.precio_centavos;

  if (paquete) {
    const fee = feePct > 0 ? Math.round((amount * feePct) / 100) : 0;
    const esperado = { target, amount, currency, fee, metadata: { tier_id: tier.id, usuario_id: miembroId } };
    const res = await ejecutarOperacion<Stripe.PaymentIntent>(
      {
        buscar: async () => {
          const lista = await stripe.paymentIntents.list({ customer: customerId, limit: 100 }, { ...opt, ...presupuesto.opcionesLectura() });
          return porOperacion(lista.data, operationId);
        },
        crear: () =>
          stripe.paymentIntents.create(
            {
              amount,
              currency,
              customer: customerId,
              metadata,
              automatic_payment_methods: { enabled: true },
              ...(fee > 0 ? { application_fee_amount: fee } : {})
            },
            { ...opt, idempotencyKey: key, ...presupuesto.opcionesMutacion() }
          ),
        evaluar: async (pi) => clasificarPaymentIntent(pi, esperado),
        invalidar: (pi) =>
          stripe.paymentIntents.cancel(pi.id, {}, { ...opt, idempotencyKey: llaveInvalidacion(kind, accountId, miembroId, operationId), ...presupuesto.opcionesMutacion() }),
        releer: (pi) => stripe.paymentIntents.retrieve(pi.id, {}, { ...opt, ...presupuesto.opcionesLectura() })
      },
      presupuesto
    );
    return responder(res, {
      ...p, kind, modo: 'pago',
      secreto: (pi) => pi.client_secret,
      monto: (pi) => ({ monto: pi.amount, moneda: pi.currency })
    });
  }

  const esperado = { target, amount, currency, fee: feePct > 0 ? feePct : 0, metadata: { tier_id: tier.id, usuario_id: miembroId } };
  const res = await ejecutarOperacion<Stripe.Subscription>(
    {
      buscar: async () => {
        const lista = await stripe.subscriptions.list(
          { customer: customerId, status: 'all', limit: 100, expand: ['data.latest_invoice.confirmation_secret'] },
          { ...opt, ...presupuesto.opcionesLectura() }
        );
        return porOperacion(lista.data, operationId);
      },
      crear: async () => {
        const price = await stripe.prices.create(
          {
            unit_amount: amount,
            currency,
            recurring: { interval: 'month' },
            product_data: { name: tier.nombre }
          },
          { ...opt, idempotencyKey: llavePrecio({ tierId: tier.id, accountId, centavos: amount, currency, nombre: tier.nombre }), ...presupuesto.opcionesMutacion() }
        );
        if (!presupuesto.puedeMutar()) throw new PresupuestoAgotado();
        return stripe.subscriptions.create(
          {
            customer: customerId,
            items: [{ price: price.id }],
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            metadata,
            ...(feePct > 0 ? { application_fee_percent: feePct } : {}),
            expand: ['latest_invoice.payment_intent', 'latest_invoice.confirmation_secret']
          },
          { ...opt, idempotencyKey: key, ...presupuesto.opcionesMutacion() }
        );
      },
      evaluar: async (sub) => clasificarSuscripcion(sub, esperado, await evidenciaPagoInicial(stripe, sub, opt, presupuesto))
    },
    presupuesto
  );
  return responder(res, {
    ...p, kind, modo: 'suscripcion',
    secreto: (sub) => secretoPrimeraFactura(sub),
    monto: (sub) => ({ monto: sub.items?.data?.[0]?.price?.unit_amount ?? null, moneda: sub.items?.data?.[0]?.price?.currency ?? currency })
  });
}

async function responder<T extends { id: string; created: number }>(
  res: ResultadoOperacion<T>,
  c: PreparacionPlan & {
    kind: KindOperacion;
    modo: 'pago' | 'suscripcion';
    secreto: (o: T) => string | null;
    monto: (o: T) => { monto: number | null; moneda: string };
  }
): Promise<RespuestaPreparacion> {
  const log = (estado: string, drift?: boolean) => registrarOperacion({ funcion: c.funcion, kind: c.kind, usuario_id: c.miembroId, estado, drift });
  if (res.tipo === 'transporte') {
    log(res.veredicto);
    return { estado: res.veredicto, operationId: c.operationId };
  }
  const base = { operationId: c.operationId, objetoId: res.objeto.id, creadoEn: res.objeto.created * 1000 };
  if (res.veredicto === 'reutilizable') {
    const clientSecret = c.secreto(res.objeto);
    if (!clientSecret) {
      log('requiere_revision', res.drift);
      return { ...base, estado: 'requiere_revision' };
    }
    log('reutilizable', res.drift);
    const customerSessionClientSecret = await crearSesionCliente(c.stripe, c.customerId, c.accountId, c.funcion, c.presupuesto);
    return {
      ...base,
      estado: 'reutilizable',
      clientSecret,
      account: c.accountId,
      modo: c.modo,
      customerSessionClientSecret,
      ...c.monto(res.objeto),
      ...(c.modo === 'suscripcion' ? { subscriptionId: res.objeto.id } : {})
    };
  }
  log(res.veredicto, res.drift);
  return { ...base, estado: res.veredicto };
}
