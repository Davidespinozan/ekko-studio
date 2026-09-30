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
    list: vi.fn(async (params: Obj, _opts: Obj) => ({ data: subs.filter((s) => s.customer === params.customer).slice().reverse() }))
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
    estado: { pis, subs, sesiones }
  };
}

export type StripeFalso = ReturnType<typeof crearStripeFalso>;
