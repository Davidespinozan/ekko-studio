import { vi } from 'vitest';

/**
 * Stripe FALSO en memoria para PKG-01C (sin red, sin Stripe LIVE). Reproduce lo
 * que importa para la idempotencia:
 *   - la MISMA idempotency key devuelve el MISMO objeto (replay);
 *   - la misma key con OTROS parámetros → error `idempotency_error` (como Stripe);
 *   - `perderRespuesta()`: el objeto SE CREA pero la llamada falla con un error
 *     de conexión (respuesta perdida / timeout ambiguo);
 *   - list por customer, cancel/expire con reglas de estado, retrieve.
 * Registra cada llamada (con sus opciones) para verificar keys y cuentas.
 */

type Obj = Record<string, any>;

const errIdempotencia = () =>
  Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters they were first used with.'), {
    type: 'StripeIdempotencyError',
    rawType: 'idempotency_error',
    statusCode: 400
  });
const errConexion = () => Object.assign(new Error('Request aborted due to timeout being reached'), { type: 'StripeConnectionError' });

export function crearStripeFalso() {
  let n = 0;
  let perder = false;
  let fallarCobro = false;
  const porKey = new Map<string, { firma: string; obj: Obj }>();
  const pis: Obj[] = [];
  const subs: Obj[] = [];
  const sesiones: Obj[] = [];

  function idempotente(key: string | undefined, params: Obj, fabricar: () => Obj): Obj {
    const firma = JSON.stringify(params);
    if (key && porKey.has(key)) {
      const prev = porKey.get(key)!;
      if (prev.firma !== firma) throw errIdempotencia();
      return prev.obj;
    }
    const obj = fabricar();
    if (key) porKey.set(key, { firma, obj });
    if (perder) {
      perder = false;
      throw errConexion(); // Stripe lo creó; la respuesta no llegó
    }
    return obj;
  }

  const paymentIntents = {
    create: vi.fn(async (params: Obj, opts: Obj) =>
      idempotente(opts.idempotencyKey, params, () => {
        const id = `pi_${++n}`;
        const obj = {
          id,
          object: 'payment_intent',
          status: 'requires_payment_method',
          amount: params.amount,
          currency: params.currency,
          application_fee_amount: params.application_fee_amount ?? null,
          customer: params.customer,
          metadata: { ...params.metadata },
          client_secret: `${id}_secret_x`,
          created: 1_700_000_000 + n
        };
        pis.push(obj);
        return obj;
      })
    ),
    list: vi.fn(async (params: Obj, _opts: Obj) => ({ data: pis.filter((p) => p.customer === params.customer).slice().reverse() })),
    cancel: vi.fn(async (id: string, _params: Obj, _opts: Obj) => {
      const p = pis.find((x) => x.id === id)!;
      if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(p.status)) {
        throw Object.assign(new Error(`cannot cancel ${p.status}`), { type: 'StripeInvalidRequestError', statusCode: 400 });
      }
      p.status = 'canceled';
      return { ...p };
    }),
    retrieve: vi.fn(async (id: string, _params: Obj, _opts: Obj) => ({ ...pis.find((x) => x.id === id)! }))
  };

  const prices = { create: vi.fn(async (params: Obj, _opts: Obj) => ({ id: `price_${params.unit_amount}`, unit_amount: params.unit_amount, currency: params.currency })) };

  const subscriptions = {
    create: vi.fn(async (params: Obj, opts: Obj) =>
      idempotente(opts.idempotencyKey, params, () => {
        const id = `sub_${++n}`;
        const amount = Number(String(params.items[0].price).replace('price_', ''));
        const obj = {
          id,
          object: 'subscription',
          status: 'incomplete',
          customer: params.customer,
          metadata: { ...params.metadata },
          application_fee_percent: params.application_fee_percent ?? null,
          items: { data: [{ price: { id: params.items[0].price, unit_amount: amount, currency: 'mxn' } }] },
          latest_invoice: { id: `in_${n}`, status: 'open', amount_paid: 0, confirmation_secret: { client_secret: `in_${n}_secret` } },
          created: 1_700_000_000 + n
        };
        subs.push(obj);
        return obj;
      })
    ),
    list: vi.fn(async (params: Obj, _opts: Obj) => ({ data: subs.filter((s) => s.customer === params.customer).slice().reverse() })),
    retrieve: vi.fn(async (id: string, _params: Obj, _opts: Obj) => {
      const s = subs.find((x) => x.id === id);
      if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { type: 'StripeInvalidRequestError', statusCode: 404 });
      return { ...s, metadata: { ...s.metadata } };
    }),
    /**
     * PKG-01F: update idempotente por key. Cambia el precio del item, mezcla
     * metadata y simula la liquidación: con `always_invoice` genera una factura
     * de prorrata pagada (o, si `fallarCobro()`, rechaza TODO el update con un
     * error de tarjeta como hace `error_if_incomplete`); con `create_prorations`
     * no factura ahora.
     */
    update: vi.fn(async (id: string, params: Obj, opts: Obj) =>
      idempotente(opts?.idempotencyKey, { id, ...params }, () => {
        const s = subs.find((x) => x.id === id);
        if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { type: 'StripeInvalidRequestError', statusCode: 404 });
        const nuevo = params.items?.[0]?.price as string | undefined;
        const unitNuevo = nuevo ? Number(String(nuevo).replace('price_', '')) : s.items.data[0].price.unit_amount;
        const unitViejo = s.items.data[0].price.unit_amount;
        if (params.proration_behavior === 'always_invoice' && params.payment_behavior === 'error_if_incomplete' && fallarCobro) {
          fallarCobro = false;
          throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', statusCode: 402 });
        }
        if (nuevo) s.items = { data: [{ ...s.items.data[0], price: { id: nuevo, unit_amount: unitNuevo, currency: 'mxn' } }] };
        if (params.metadata) s.metadata = { ...s.metadata, ...params.metadata };
        if (params.proration_behavior === 'always_invoice') {
          s.latest_invoice = { id: `in_${++n}`, status: 'paid', amount_paid: Math.max(0, unitNuevo - unitViejo), currency: 'mxn', billing_reason: 'subscription_update' };
        }
        return { ...s, metadata: { ...s.metadata } };
      })
    )
  };

  const invoices = { list: vi.fn(async (_params: Obj, _opts: Obj) => ({ data: [] as Obj[] })) };

  const checkout = {
    sessions: {
      create: vi.fn(async (params: Obj, opts: Obj) =>
        idempotente(opts.idempotencyKey, params, () => {
          const id = `cs_${++n}`;
          const unit = params.line_items[0].price_data.unit_amount;
          const obj = {
            id,
            object: 'checkout.session',
            status: 'open',
            payment_status: 'unpaid',
            amount_total: unit,
            currency: params.line_items[0].price_data.currency,
            mode: params.mode,
            ui_mode: params.ui_mode ?? 'hosted',
            customer: params.customer,
            metadata: { ...params.metadata },
            client_secret: params.ui_mode === 'embedded' ? `${id}_secret` : null,
            url: params.ui_mode === 'embedded' ? null : `https://checkout.stripe.test/${id}`,
            created: 1_700_000_000 + n
          };
          sesiones.push(obj);
          return obj;
        })
      ),
      list: vi.fn(async (params: Obj, _opts: Obj) => ({ data: sesiones.filter((s) => s.customer === params.customer).slice().reverse() })),
      expire: vi.fn(async (id: string, _params: Obj, _opts: Obj) => {
        const s = sesiones.find((x) => x.id === id)!;
        if (s.status !== 'open') throw Object.assign(new Error('not open'), { type: 'StripeInvalidRequestError', statusCode: 400 });
        s.status = 'expired';
        return { ...s };
      }),
      retrieve: vi.fn(async (id: string, _params: Obj, _opts: Obj) => ({ ...sesiones.find((x) => x.id === id)! }))
    }
  };

  const customerSessions = { create: vi.fn(async (_params: Obj, _opts: Obj) => ({ client_secret: 'cuss_secret' })) };

  return {
    paymentIntents,
    prices,
    subscriptions,
    invoices,
    checkout,
    customerSessions,
    /** La PRÓXIMA creación ocurre en Stripe pero su respuesta se pierde. */
    perderRespuesta() {
      perder = true;
    },
    /** El PRÓXIMO update con cobro inmediato falla como una tarjeta rechazada (nada cambia). */
    fallarCobro() {
      fallarCobro = true;
    },
    /** Siembra una suscripción existente (para cambios de plan). */
    sembrarSuscripcion(o: { id: string; customer: string; unit_amount: number; status?: string; metadata?: Obj; cancel_at_period_end?: boolean }) {
      const obj = {
        id: o.id,
        object: 'subscription',
        status: o.status ?? 'active',
        customer: o.customer,
        cancel_at_period_end: o.cancel_at_period_end ?? false,
        metadata: { app: 'ekko', ...(o.metadata ?? {}) },
        application_fee_percent: null,
        items: { data: [{ id: `si_${o.id}`, price: { id: `price_${o.unit_amount}`, unit_amount: o.unit_amount, currency: 'mxn' } }] },
        latest_invoice: { id: `in_${o.id}`, status: 'paid', amount_paid: o.unit_amount, currency: 'mxn', billing_reason: 'subscription_cycle' },
        created: 1_700_000_000
      };
      subs.push(obj);
      return obj;
    },
    estado: { pis, subs, sesiones }
  };
}

export type StripeFalso = ReturnType<typeof crearStripeFalso>;
