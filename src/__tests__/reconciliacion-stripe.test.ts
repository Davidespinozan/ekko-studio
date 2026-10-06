import { describe, it, expect, vi } from 'vitest';
import {
  compararEstudio,
  lecturaStripe,
  reconciliarStripe,
  type MembresiaLocal,
  type StripeLectura,
  type SuscripcionStripe
} from '../../netlify/functions/_lib/reconciliacionStripe';

/**
 * PKG-03B · reconciliador detect-only (D-03B-1 = A). Stripe SIEMPRE simulado.
 * La persistencia (una abierta por identidad, cierre por convergencia, parcial no
 * cierra) se prueba contra Postgres real en src/__tests__/db/03b-reconciliacion-stripe.db.test.ts.
 */

const AHORA = Date.parse('2026-10-06T12:00:00Z');
const HACE_3D = '2026-10-03T12:00:00Z';
const HACE_1H = '2026-10-06T11:00:00Z';

const mem = (p: Partial<MembresiaLocal> = {}): MembresiaLocal => ({
  membresia_id: 'm1', usuario_id: 'u1', stripe_subscription_id: 'sub_1', status: 'activa', tier_id: 'tier_a',
  cancel_at_period_end: false, pausa_comercial_at: null, updated_at: HACE_3D, created_at: HACE_3D,
  usuario_status: 'activo', sancionado: false, operacion_en_vuelo: false, ...p
});
const sub = (p: Partial<SuscripcionStripe> = {}): SuscripcionStripe => ({
  id: 'sub_1', status: 'active', pause_collection: null, cancel_at_period_end: false,
  created: Date.parse(HACE_3D) / 1000, metadata: { app: 'ekko', tier_id: 'tier_a' }, ...p
});
const tipos = (l: MembresiaLocal[], s: SuscripcionStripe[], completa = true) =>
  compararEstudio(l, s, { lecturaCompleta: completa, ahora: AHORA }).map((d) => d.tipo);

describe('compararEstudio', () => {
  it('1 · suscripción que coincide en todo → ninguna discrepancia', () => {
    expect(tipos([mem()], [sub()])).toEqual([]);
  });

  it('2 · EKKO espera la suscripción y Stripe no la tiene → ausente (solo con lectura completa)', () => {
    expect(tipos([mem()], [])).toEqual(['suscripcion_ausente']);
    // 13 · con lectura parcial NO se afirma "falta".
    expect(tipos([mem()], [], false)).toEqual([]);
  });

  it('3 · huérfana: Stripe viva sin membresía de EKKO; y membresía terminada hace >48 h con la suscripción viva', () => {
    expect(tipos([], [sub({ id: 'sub_x' })])).toEqual(['suscripcion_huerfana']);
    expect(tipos([mem({ status: 'cancelada' })], [sub()])).toEqual(['suscripcion_huerfana']);
    // recién creada (checkout en curso) → gracia; terminada o transitoria → nada
    expect(tipos([], [sub({ id: 'sub_y', created: Date.parse(HACE_1H) / 1000 + 600 })])).toEqual([]);
    expect(tipos([], [sub({ id: 'sub_z', status: 'canceled' })])).toEqual([]);
    expect(tipos([mem()], [sub({ status: 'incomplete' })])).toEqual([]);
  });

  it('17 · lo que cubre la automatización de 48 h NO se reporta (no se pisan)', () => {
    expect(tipos([mem({ status: 'cancelada', updated_at: HACE_1H })], [sub()])).toEqual([]);
  });

  it('4 · estado: EKKO viva, Stripe terminada', () => {
    expect(tipos([mem()], [sub({ status: 'canceled' })])).toEqual(['estado_distinto']);
    expect(tipos([mem()], [sub({ status: 'unpaid' })])).toEqual(['estado_distinto']); // mismo mapeo que el sync
  });

  it('5 · pausa por sanción: sancionado y Stripe cobrando → pausa_distinta; sancionado y en pausa → nada', () => {
    const d = compararEstudio([mem({ sancionado: true })], [sub()], { lecturaCompleta: true, ahora: AHORA });
    expect(d.map((x) => x.tipo)).toEqual(['pausa_distinta']);
    expect(d[0].esperado).toMatchObject({ pausa: true, razones: ['sancion'] });
    expect(tipos([mem({ sancionado: true, status: 'pausada' })], [sub({ pause_collection: { behavior: 'void' } })])).toEqual([]);
  });

  it('6 · 21 · pausa comercial (EKKO-138) y Stripe cobrando → pausa_distinta; la intención manda, no el reflejo', () => {
    expect(tipos([mem({ pausa_comercial_at: HACE_3D, status: 'pausada' })], [sub()])).toEqual(['pausa_distinta']);
    // Reflejo 'pausada' SIN intención ni sanción y Stripe en pausa → el proveedor pausó sin intención de EKKO.
    expect(tipos([mem({ status: 'pausada' })], [sub({ pause_collection: { behavior: 'void' } })])).toEqual(['pausa_distinta']);
    // Reactivada durante sanción (EKKO-139): membresía 'activa' y Stripe en pausa por la sanción → coincide.
    expect(tipos([mem({ sancionado: true })], [sub({ pause_collection: { behavior: 'void' } })])).toEqual([]);
  });

  it('una operación de cobro en vuelo (ya visible en Operación) no se duplica como discrepancia', () => {
    expect(tipos([mem({ sancionado: true, operacion_en_vuelo: true })], [sub()])).toEqual([]);
  });

  it('7 · cancelación al fin del periodo distinta', () => {
    expect(tipos([mem()], [sub({ cancel_at_period_end: true })])).toEqual(['cancelacion_distinta']);
    expect(tipos([mem({ cancel_at_period_end: true })], [sub()])).toEqual(['cancelacion_distinta']);
  });

  it('8 · plan: el tier que EKKO escribió en la suscripción no es el de la membresía; sin tier en metadata no se adivina', () => {
    expect(tipos([mem()], [sub({ metadata: { app: 'ekko', tier_id: 'tier_b' } })])).toEqual(['plan_distinto']);
    expect(tipos([mem()], [sub({ metadata: { app: 'ekko' } })])).toEqual([]);
  });

  it('16 · lo de otra app se ignora entero (aunque una membresía lo refiera); sin marca y sin membresía, no se afirma nada', () => {
    expect(tipos([], [sub({ id: 'sub_sala', metadata: { app: 'sala' } })])).toEqual([]);
    expect(tipos([mem()], [sub({ metadata: { app: 'sala', tier_id: 'x' }, status: 'canceled' })])).toEqual([]);
    expect(tipos([], [sub({ id: 'sub_sin_marca', metadata: {} })])).toEqual([]);
  });

  it('22 · cuenta revocada: suscripción viva = huérfana (EKKO-130); nunca se "repara" ni se espera reanudar', () => {
    const d = compararEstudio([mem({ usuario_status: 'revocado', sancionado: true })], [sub()], { lecturaCompleta: true, ahora: AHORA });
    expect(d.map((x) => [x.tipo, x.esperado.motivo])).toEqual([['suscripcion_huerfana', 'cuenta_revocada']]);
    expect(tipos([mem({ usuario_status: 'revocado' })], [sub({ status: 'canceled' })])).toEqual([]);
  });

  it('snapshots mínimos: sin payload de Stripe ni PII', () => {
    const [d] = compararEstudio([mem({ sancionado: true })], [sub()], { lecturaCompleta: true, ahora: AHORA });
    expect(Object.keys(d.observado).sort()).toEqual(['cancel_at_period_end', 'pausa', 'resumen', 'status', 'tier_id']);
  });
});

// ── Orquestador ──────────────────────────────────────────────────────────────
type Rpc = { fn: string; args: Record<string, unknown> };
type Opciones = {
  fallaLocal?: boolean;
  /** Corridas ya asentadas del estudio (fase D: ¿otra corrida terminó después de que esta empezó?). */
  corridasPosteriores?: Record<string, number>;
  /** Primera llamada a registrar con observaciones → choque del índice único (otra corrida insertó lo mismo). */
  conflictoUnico?: boolean;
};
function adminSimulado(tenants: Array<{ id: string; stripe_account_id: string }>, locales: Record<string, unknown[]>, opts: Opciones | boolean = {}) {
  const o: Opciones = typeof opts === 'boolean' ? { fallaLocal: opts } : opts;
  const rpcs: Rpc[] = [];
  let conflictoPendiente = Boolean(o.conflictoUnico);
  const admin = {
    rpcs,
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (conflictoPendiente && ((args.p_discrepancias as unknown[]) ?? []).length > 0) {
        conflictoPendiente = false;
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "discrepancias_stripe_abierta_uniq"' } });
      }
      return Promise.resolve({ data: {}, error: null });
    },
    from: (tabla: string) => {
      let tenant = '';
      const c: Record<string, unknown> = {};
      c.select = () => c; c.not = () => c; c.in = () => c; c.gt = () => c; c.limit = () => c;
      c.eq = (col: string, v: string) => { if (col === 'tenant_id') tenant = v; return c; };
      c.then = (cb: (v: unknown) => unknown) => {
        if (tabla === 'tenants') return Promise.resolve({ data: tenants, error: null }).then(cb);
        if (tabla === 'membresias') return Promise.resolve(o.fallaLocal ? { data: null, error: { message: 'timeout' } } : { data: locales[tenant] ?? [], error: null }).then(cb);
        if (tabla === 'usuarios') return Promise.resolve({ data: [{ id: 'u1', status: 'activo', sancionado_at: null }], error: null }).then(cb);
        if (tabla === 'reconciliacion_stripe_corridas') {
          const n = o.corridasPosteriores?.[tenant] ?? 0;
          return Promise.resolve({ data: Array.from({ length: n }, () => ({ terminada_at: 'x' })), error: null }).then(cb);
        }
        return Promise.resolve({ data: [], error: null }).then(cb);
      };
      return c;
    }
  };
  return admin;
}
const filaMem = (p: Record<string, unknown> = {}) => ({ id: 'm1', usuario_id: 'u1', stripe_subscription_id: 'sub_1', status: 'activa', tier_id: 'tier_a',
  cancel_at_period_end: false, pausa_comercial_at: null, updated_at: HACE_3D, created_at: HACE_3D, ...p });
const asientos = (a: { rpcs: Rpc[] }) => a.rpcs.filter((r) => r.fn === 'registrar_reconciliacion_stripe').map((r) => r.args);

describe('reconciliarStripe', () => {
  it('14 · pagina hasta el final y 15 · lee cada estudio SOLO en su cuenta conectada', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }, { id: 't2', stripe_account_id: 'acct_2' }],
      { t1: [filaMem()], t2: [] });
    const llamadas: Array<[string, string | undefined]> = [];
    const stripe: StripeLectura = {
      cuentaEsDeEkko: async () => true,
      listarSuscripciones: async (acct, after) => {
        llamadas.push([acct, after]);
        if (acct === 'acct_1' && !after) return { data: [sub({ id: 'sub_0' })], has_more: true };
        if (acct === 'acct_1') return { data: [sub()], has_more: false };
        return { data: [], has_more: false };
      }
    };
    const r = await reconciliarStripe(admin as never, stripe, { ahora: () => AHORA });
    expect(llamadas).toEqual([['acct_1', undefined], ['acct_1', 'sub_0'], ['acct_2', undefined]]);
    const a = asientos(admin);
    expect(a.map((x) => [x.p_tenant_id, x.p_estado, x.p_suscripciones_leidas])).toEqual([['t1', 'completa', 2], ['t2', 'completa', 0]]);
    // sub_0 de EKKO sin membresía → huérfana; sub_1 coincide.
    expect((a[0].p_discrepancias as Array<{ tipo: string }>).map((d) => d.tipo)).toEqual(['suscripcion_huerfana']);
    expect(new Set(a.map((x) => x.p_corrida_id)).size).toBe(1);
    expect(r.estudios).toHaveLength(2);
  });

  it('12 · 13 · fallo a mitad de la paginación → PARCIAL: no afirma "ausente" y la base no cierra nada', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }], { t1: [filaMem(), filaMem({ id: 'm2', stripe_subscription_id: 'sub_2' })] });
    const stripe: StripeLectura = {
      cuentaEsDeEkko: async () => true,
      listarSuscripciones: async (_a, after) => {
        if (!after) return { data: [sub()], has_more: true };
        throw Object.assign(new Error('rate'), { type: 'StripeRateLimitError', statusCode: 429 });
      }
    };
    await reconciliarStripe(admin as never, stripe, { ahora: () => AHORA });
    const [a] = asientos(admin);
    expect(a.p_estado).toBe('parcial');
    expect(a.p_error).toBe('stripe:StripeRateLimitError:429');
    expect(a.p_discrepancias).toEqual([]); // sub_2 no se vio: NO se reporta ausente
  });

  it('falla la primera lectura → FALLIDA sin observaciones; un estudio con error no detiene a los demás', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }, { id: 't2', stripe_account_id: 'acct_2' }], { t1: [filaMem()], t2: [] });
    const stripe: StripeLectura = {
      cuentaEsDeEkko: async () => true,
      listarSuscripciones: async (acct) => { if (acct === 'acct_1') throw new Error('boom'); return { data: [], has_more: false }; }
    };
    await reconciliarStripe(admin as never, stripe, { ahora: () => AHORA });
    expect(asientos(admin).map((x) => [x.p_tenant_id, x.p_estado, (x.p_discrepancias as unknown[]).length])).toEqual([['t1', 'fallida', 0], ['t2', 'completa', 0]]);
  });

  it('límite de páginas → PARCIAL (acotado); cuenta conectada de otra app → FALLIDA sin leer suscripciones', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }, { id: 't2', stripe_account_id: 'acct_ajena' }], { t1: [], t2: [] });
    const listar = vi.fn(async () => ({ data: [sub({ id: `sub_${Math.random()}` })], has_more: true }));
    const stripe: StripeLectura = { cuentaEsDeEkko: async (a) => a !== 'acct_ajena', listarSuscripciones: listar };
    await reconciliarStripe(admin as never, stripe, { maxPaginas: 3, ahora: () => AHORA });
    expect(asientos(admin).map((x) => [x.p_estado, x.p_error])).toEqual([['parcial', 'limite_paginas'], ['fallida', 'cuenta_de_otra_app']]);
    expect(listar).toHaveBeenCalledTimes(3);
  });

  it('si no se puede leer EKKO, el estudio queda FALLIDO (sin leer Stripe)', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }], {}, true);
    const listar = vi.fn();
    await reconciliarStripe(admin as never, { cuentaEsDeEkko: async () => true, listarSuscripciones: listar }, { ahora: () => AHORA });
    expect(asientos(admin)[0]).toMatchObject({ p_estado: 'fallida', p_discrepancias: [] });
    expect(listar).not.toHaveBeenCalled();
  });
});

describe('18 · la fachada de Stripe es de solo lectura', () => {
  it('solo usa accounts.retrieve y subscriptions.list (cualquier otro método del SDK revienta)', async () => {
    const usados: string[] = [];
    const trampa = (ruta: string): unknown => new Proxy(() => undefined, {
      get: (_t, p: string) => {
        const r = `${ruta}.${p}`;
        if (r === 'stripe.accounts.retrieve') return async () => { usados.push(r); return { metadata: { app: 'ekko' } }; };
        if (r === 'stripe.subscriptions.list') return async (params: Record<string, unknown>, opt: Record<string, unknown>) => {
          usados.push(r);
          expect(params).toMatchObject({ status: 'all', limit: 100 });
          expect(opt).toEqual({ stripeAccount: 'acct_1' });
          return { data: [], has_more: false };
        };
        if (['stripe.accounts', 'stripe.subscriptions'].includes(r)) return trampa(r);
        if (ruta === 'stripe') return trampa(r);
        throw new Error(`método de Stripe NO permitido: ${r}`);
      }
    });
    const l = lecturaStripe(trampa('stripe') as never);
    expect(await l.cuentaEsDeEkko('acct_1')).toBe(true);
    await l.listarSuscripciones('acct_1');
    expect(usados).toEqual(['stripe.accounts.retrieve', 'stripe.subscriptions.list']);
    expect(Object.keys(l).sort()).toEqual(['cuentaEsDeEkko', 'listarSuscripciones']);
  });
});

describe('fase D · solapamiento entre cron y manual (mismo núcleo)', () => {
  it('9-10 · una corrida que leyó ANTES de que otra asentara el estudio NO asienta observaciones: parcial + superada_por_corrida_posterior (no cierra ni abre con datos viejos)', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }, { id: 't2', stripe_account_id: 'acct_2' }],
      { t1: [filaMem()], t2: [] }, { corridasPosteriores: { t1: 1 } });
    const stripe: StripeLectura = { cuentaEsDeEkko: async () => true, listarSuscripciones: async () => ({ data: [sub({ id: 'sub_0' })], has_more: false }) };
    const r = await reconciliarStripe(admin as never, stripe, { ahora: () => AHORA });
    const a = asientos(admin);
    expect(a.map((x) => [x.p_tenant_id, x.p_estado, x.p_suscripciones_leidas, (x.p_discrepancias as unknown[]).length, x.p_error])).toEqual([
      ['t1', 'parcial', 1, 0, 'superada_por_corrida_posterior'],
      ['t2', 'completa', 1, 1, null] // el otro estudio no estaba superado: normal
    ]);
    expect(r.estudios[0]).toMatchObject({ estado: 'parcial', discrepancias: 0 });
  });

  it('11 · dos corridas insertan la misma discrepancia nueva a la vez: la segunda choca con el índice único y se asienta parcial + conflicto_concurrente (sin perder su registro ni duplicar)', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }], { t1: [] }, { conflictoUnico: true });
    const stripe: StripeLectura = { cuentaEsDeEkko: async () => true, listarSuscripciones: async () => ({ data: [sub({ id: 'sub_0' })], has_more: false }) };
    const r = await reconciliarStripe(admin as never, stripe, { ahora: () => AHORA });
    const a = asientos(admin);
    expect(a).toHaveLength(2);
    expect((a[0].p_discrepancias as unknown[]).length).toBe(1); // intento original
    expect(a[1]).toMatchObject({ p_estado: 'parcial', p_discrepancias: [], p_error: 'conflicto_concurrente', p_suscripciones_leidas: 1 });
    expect(r.estudios[0]).toMatchObject({ estado: 'parcial', discrepancias: 0, error: 'conflicto_concurrente' });
  });

  it('un choque único en una corrida sin observaciones no se maquilla: el error se propaga', async () => {
    const admin = adminSimulado([{ id: 't1', stripe_account_id: 'acct_1' }], { t1: [] });
    admin.rpc = () => Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } });
    const stripe: StripeLectura = { cuentaEsDeEkko: async () => true, listarSuscripciones: async () => ({ data: [], has_more: false }) };
    await expect(reconciliarStripe(admin as never, stripe, { ahora: () => AHORA })).rejects.toThrow(/registrar_reconciliacion_stripe/);
  });
});
