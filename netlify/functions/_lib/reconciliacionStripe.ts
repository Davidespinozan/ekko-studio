import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { APP_ID, esDeOtraApp, mapStripeStatus } from './stripe';

/**
 * PKG-03B · Reconciliador Stripe — DETECT-ONLY (D-03B-1 = A).
 *
 * Responde "¿qué cree EKKO que debe existir?" contra "¿qué contiene Stripe?" y
 * deja evidencia durable de cada diferencia (`discrepancias_stripe`). NUNCA
 * repara: no pausa, no reanuda, no cancela, no cambia precios ni membresías. La
 * única reparación automática sigue siendo la cancelación de huérfanas de las
 * últimas 48 h en cron-expirar-membresias (sin cambios); lo que esa ventana
 * cubre aquí no se reporta, para que ambos mecanismos no se pisen.
 *
 * Autoridades:
 *   · Stripe: existencia, `status`, `pause_collection`, `cancel_at_period_end`
 *     y el `metadata.tier_id` que EKKO escribe al crear/cambiar de plan.
 *   · EKKO: membresía viva o terminada, plan (`tier_id`), sanción, revocación e
 *     intención de pausa comercial (`pausa_comercial_at`, EKKO-138).
 *   · Reflejo (no autoridad): `membresias.status = 'pausada'`, `periodo_actual_fin`.
 *     La pausa se compara contra la INTENCIÓN (sanción o pausa comercial), nunca
 *     contra el reflejo.
 *
 * Alcance: solo las cuentas conectadas de `tenants.stripe_account_id` (las crea
 * el onboarding de EKKO) y, dentro, solo suscripciones con `metadata.app = 'ekko'`
 * o referidas por una membresía de EKKO. Lo de otra app se ignora entero.
 */

const VIVAS_LOCAL = new Set(['trialing', 'activa', 'past_due', 'pausada']);
const VENTANA_AUTOMATIZACION_MS = 48 * 3600_000;
const GRACIA_ALTA_MS = 3600_000; // checkout recién creado: el webhook aún no llega

export type TipoDiscrepancia =
  | 'suscripcion_ausente'
  | 'suscripcion_huerfana'
  | 'estado_distinto'
  | 'pausa_distinta'
  | 'cancelacion_distinta'
  | 'plan_distinto';

export interface MembresiaLocal {
  membresia_id: string;
  usuario_id: string | null;
  stripe_subscription_id: string;
  status: string;
  tier_id: string | null;
  cancel_at_period_end: boolean | null;
  pausa_comercial_at: string | null;
  updated_at: string;
  created_at: string;
  usuario_status: string | null;
  sancionado: boolean;
  /** Hay una operación de cobro pendiente/fallida: el cambio ya está en curso y visible en Operación. */
  operacion_en_vuelo: boolean;
}

export interface SuscripcionStripe {
  id: string;
  status: string;
  pause_collection: unknown | null;
  cancel_at_period_end: boolean;
  created: number;
  metadata: Record<string, string> | null;
}

export interface Discrepancia {
  stripe_subscription_id: string;
  tipo: TipoDiscrepancia;
  membresia_id: string | null;
  usuario_id: string | null;
  esperado: Record<string, unknown> & { resumen: string };
  observado: Record<string, unknown> & { resumen: string };
}

function vidaStripe(s: SuscripcionStripe): 'viva' | 'terminada' | 'transitoria' {
  if (s.status === 'paused') return 'viva';
  const m = mapStripeStatus(s.status);
  if (m === 'activa' || m === 'past_due') return 'viva';
  if (m === 'cancelada') return 'terminada';
  return 'transitoria'; // incomplete, etc.: aún no hay hecho que comparar
}

function observado(s: SuscripcionStripe): Discrepancia['observado'] {
  const pausada = s.pause_collection != null;
  return {
    resumen: `${s.status}${pausada ? ' en pausa' : ''}${s.cancel_at_period_end ? ', cancela al fin del periodo' : ''}`,
    status: s.status,
    pausa: pausada,
    cancel_at_period_end: s.cancel_at_period_end,
    tier_id: s.metadata?.tier_id ?? null
  };
}

/**
 * Compara UN estudio. Pura: sin red ni base. `lecturaCompleta` = se leyeron todas
 * las suscripciones de la cuenta; sin ella NO se afirma que algo "falta".
 */
export function compararEstudio(
  locales: MembresiaLocal[],
  suscripciones: SuscripcionStripe[],
  opts: { lecturaCompleta: boolean; ahora: number }
): Discrepancia[] {
  const out: Discrepancia[] = [];
  const porId = new Map(suscripciones.map((s) => [s.id, s]));

  // Una membresía "gobierna" cada suscripción: la viva más reciente; si no hay, la más reciente.
  const porSub = new Map<string, MembresiaLocal>();
  for (const m of [...locales].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const actual = porSub.get(m.stripe_subscription_id);
    if (!actual || VIVAS_LOCAL.has(m.status) || !VIVAS_LOCAL.has(actual.status)) porSub.set(m.stripe_subscription_id, m);
  }

  for (const [subId, m] of porSub) {
    const s = porId.get(subId);
    const ref = { stripe_subscription_id: subId, membresia_id: m.membresia_id, usuario_id: m.usuario_id };
    const viva = VIVAS_LOCAL.has(m.status);

    if (!s) {
      if (viva && opts.lecturaCompleta) {
        out.push({ ...ref, tipo: 'suscripcion_ausente',
          esperado: { resumen: `membresía ${m.status} con esta suscripción`, status: m.status },
          observado: { resumen: 'no existe en la cuenta conectada' } });
      }
      continue;
    }
    if (esDeOtraApp(s.metadata)) continue; // nunca opinamos de objetos de otra app
    const vida = vidaStripe(s);
    if (vida === 'transitoria') continue;

    if (viva) {
      if (m.usuario_status === 'revocado') {
        // EKKO-130: revocación terminal → la suscripción debe estar cancelada.
        if (vida === 'viva' && !m.operacion_en_vuelo) {
          out.push({ ...ref, tipo: 'suscripcion_huerfana',
            esperado: { resumen: 'cuenta revocada: suscripción cancelada', motivo: 'cuenta_revocada' }, observado: observado(s) });
        }
        continue;
      }
      if (vida === 'terminada') {
        if (!m.operacion_en_vuelo) {
          out.push({ ...ref, tipo: 'estado_distinto',
            esperado: { resumen: `membresía ${m.status}`, status: m.status }, observado: observado(s) });
        }
        continue;
      }
      // Viva en ambos lados: pausa (contra la intención), cancelación al fin de periodo y plan.
      const razones = [m.sancionado ? 'sancion' : null, m.pausa_comercial_at ? 'pausa_comercial' : null].filter(Boolean) as string[];
      const pausaEsperada = razones.length > 0;
      const pausaObservada = s.pause_collection != null;
      if (pausaEsperada !== pausaObservada && !m.operacion_en_vuelo) {
        out.push({ ...ref, tipo: 'pausa_distinta',
          esperado: { resumen: pausaEsperada ? `cobro en pausa (${razones.join(' + ')})` : 'cobro activo', pausa: pausaEsperada, razones },
          observado: observado(s) });
      }
      const cancelLocal = Boolean(m.cancel_at_period_end);
      if (cancelLocal !== s.cancel_at_period_end) {
        out.push({ ...ref, tipo: 'cancelacion_distinta',
          esperado: { resumen: cancelLocal ? 'cancela al fin del periodo' : 'renueva', cancel_at_period_end: cancelLocal },
          observado: observado(s) });
      }
      const tierStripe = s.metadata?.tier_id;
      if (tierStripe && m.tier_id && tierStripe !== m.tier_id) {
        out.push({ ...ref, tipo: 'plan_distinto',
          esperado: { resumen: 'plan de la membresía', tier_id: m.tier_id }, observado: observado(s) });
      }
      continue;
    }

    // Membresía terminada y suscripción viva: huérfana. Las de las últimas 48 h
    // las cancela la automatización existente: no se reportan aquí.
    if (vida === 'viva' && !m.operacion_en_vuelo
        && opts.ahora - Date.parse(m.updated_at) > VENTANA_AUTOMATIZACION_MS) {
      out.push({ ...ref, tipo: 'suscripcion_huerfana',
        esperado: { resumen: `membresía ${m.status}: suscripción cancelada`, motivo: 'membresia_terminada' }, observado: observado(s) });
    }
  }

  // Suscripciones de EKKO en Stripe que ninguna membresía refiere.
  for (const s of suscripciones) {
    if (porSub.has(s.id)) continue;
    if (s.metadata?.app !== APP_ID) continue; // sin marca de EKKO no se puede afirmar que es nuestra
    if (vidaStripe(s) !== 'viva') continue;
    if (opts.ahora - s.created * 1000 < GRACIA_ALTA_MS) continue;
    out.push({ stripe_subscription_id: s.id, tipo: 'suscripcion_huerfana', membresia_id: null,
      usuario_id: null,
      esperado: { resumen: 'ninguna membresía de EKKO la usa', motivo: 'sin_membresia' }, observado: observado(s) });
  }
  return out;
}

/** Fachada de SOLO LECTURA: lo único del SDK que el reconciliador puede tocar. */
export interface StripeLectura {
  cuentaEsDeEkko(accountId: string): Promise<boolean>;
  listarSuscripciones(accountId: string, startingAfter?: string): Promise<{ data: SuscripcionStripe[]; has_more: boolean }>;
}

export function lecturaStripe(stripe: Stripe): StripeLectura {
  return {
    async cuentaEsDeEkko(accountId) {
      const a = await stripe.accounts.retrieve(accountId);
      return !esDeOtraApp((a.metadata ?? null) as { app?: string } | null);
    },
    async listarSuscripciones(accountId, startingAfter) {
      const r = await stripe.subscriptions.list(
        { status: 'all', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
        { stripeAccount: accountId }
      );
      return {
        has_more: r.has_more,
        data: r.data.map((s) => ({
          id: s.id,
          status: s.status,
          pause_collection: s.pause_collection ?? null,
          cancel_at_period_end: Boolean(s.cancel_at_period_end),
          created: s.created,
          metadata: (s.metadata ?? null) as Record<string, string> | null
        }))
      };
    }
  };
}

export interface ResultadoEstudio {
  tenant_id: string;
  estado: 'completa' | 'parcial' | 'fallida';
  suscripciones_leidas: number;
  discrepancias: number;
  error: string | null;
}

function claseError(e: unknown): string {
  const t = (e as { type?: string; code?: string; statusCode?: number } | null) ?? {};
  return [t.type, t.code, t.statusCode].filter(Boolean).join(':') || (e instanceof Error ? e.name : 'error');
}

/**
 * Una corrida: por cada estudio con cuenta conectada, lee Stripe (paginado y
 * acotado), compara y asienta. Un fallo en un estudio no detiene a los demás ni
 * cierra nada: queda `parcial` o `fallida` en su corrida.
 */
export async function reconciliarStripe(
  admin: SupabaseClient,
  stripe: StripeLectura,
  opts: { maxPaginas?: number; presupuestoMs?: number; ahora?: () => number } = {}
): Promise<{ corrida_id: string; estudios: ResultadoEstudio[] }> {
  const ahora = opts.ahora ?? Date.now;
  const fin = ahora() + (opts.presupuestoMs ?? 8000);
  const maxPaginas = opts.maxPaginas ?? 20;
  const corridaId = randomUUID();
  const estudios: ResultadoEstudio[] = [];

  const { data: tenants, error: errT } = await admin.from('tenants').select('id, stripe_account_id').not('stripe_account_id', 'is', null);
  if (errT) throw new Error(`tenants: ${errT.message}`);

  for (const t of (tenants ?? []) as Array<{ id: string; stripe_account_id: string }>) {
    const asentar = async (estado: ResultadoEstudio['estado'], leidas: number, discrepancias: Discrepancia[], error: string | null) => {
      const { error: e } = await admin.rpc('registrar_reconciliacion_stripe', {
        p_corrida_id: corridaId, p_tenant_id: t.id, p_estado: estado, p_suscripciones_leidas: leidas,
        p_discrepancias: estado === 'fallida' ? [] : discrepancias, p_error: error
      });
      if (e) throw new Error(`registrar_reconciliacion_stripe: ${e.message}`);
      estudios.push({ tenant_id: t.id, estado, suscripciones_leidas: leidas, discrepancias: discrepancias.length, error });
    };

    if (ahora() > fin) {
      await asentar('fallida', 0, [], 'presupuesto_agotado');
      continue;
    }
    // Universo local (antes de leer Stripe: si falla, no hay comparación posible).
    let locales: MembresiaLocal[];
    try {
      locales = await universoLocal(admin, t.id);
    } catch (e) {
      await asentar('fallida', 0, [], `local:${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
      continue;
    }

    let suscripciones: SuscripcionStripe[] = [];
    let completa = true;
    let error: string | null = null;
    try {
      if (!(await stripe.cuentaEsDeEkko(t.stripe_account_id))) {
        await asentar('fallida', 0, [], 'cuenta_de_otra_app');
        continue;
      }
      let cursor: string | undefined;
      for (let pagina = 0; ; pagina++) {
        if (pagina >= maxPaginas) { completa = false; error = 'limite_paginas'; break; }
        if (ahora() > fin) { completa = false; error = 'presupuesto_agotado'; break; }
        const r = await stripe.listarSuscripciones(t.stripe_account_id, cursor);
        suscripciones = suscripciones.concat(r.data);
        if (!r.has_more || r.data.length === 0) break;
        cursor = r.data[r.data.length - 1].id;
      }
    } catch (e) {
      completa = false;
      error = `stripe:${claseError(e)}`;
      if (suscripciones.length === 0) {
        await asentar('fallida', 0, [], error);
        continue;
      }
    }

    const discrepancias = compararEstudio(locales, suscripciones, { lecturaCompleta: completa, ahora: ahora() });
    await asentar(completa ? 'completa' : 'parcial', suscripciones.length, discrepancias, error);
  }
  return { corrida_id: corridaId, estudios };
}

async function universoLocal(admin: SupabaseClient, tenantId: string): Promise<MembresiaLocal[]> {
  const { data: mems, error } = await admin
    .from('membresias')
    .select('id, usuario_id, stripe_subscription_id, status, tier_id, cancel_at_period_end, pausa_comercial_at, updated_at, created_at')
    .eq('tenant_id', tenantId)
    .not('stripe_subscription_id', 'is', null);
  if (error) throw new Error(error.message);
  const filas = (mems ?? []) as Array<{
    id: string; usuario_id: string | null; stripe_subscription_id: string; status: string; tier_id: string | null;
    cancel_at_period_end: boolean | null; pausa_comercial_at: string | null; updated_at: string; created_at: string;
  }>;
  if (filas.length === 0) return [];

  const ids = [...new Set(filas.map((f) => f.usuario_id).filter((x): x is string => Boolean(x)))];
  const [{ data: us, error: eu }, { data: ops, error: eo }] = await Promise.all([
    ids.length ? admin.from('usuarios').select('id, status, sancionado_at').in('id', ids) : Promise.resolve({ data: [], error: null }),
    admin.from('stripe_operaciones_suscripcion').select('membresia_id').eq('tenant_id', tenantId).in('estado', ['pendiente', 'fallida'])
  ]);
  if (eu) throw new Error(eu.message);
  if (eo) throw new Error(eo.message);
  const usuario = new Map(((us ?? []) as Array<{ id: string; status: string; sancionado_at: string | null }>).map((u) => [u.id, u]));
  const enVuelo = new Set(((ops ?? []) as Array<{ membresia_id: string | null }>).map((o) => o.membresia_id).filter(Boolean));

  return filas.map((f) => {
    const u = f.usuario_id ? usuario.get(f.usuario_id) : undefined;
    return {
      membresia_id: f.id,
      usuario_id: f.usuario_id,
      stripe_subscription_id: f.stripe_subscription_id,
      status: f.status,
      tier_id: f.tier_id,
      cancel_at_period_end: f.cancel_at_period_end,
      pausa_comercial_at: f.pausa_comercial_at,
      updated_at: f.updated_at,
      created_at: f.created_at,
      usuario_status: u?.status ?? null,
      sancionado: Boolean(u?.sancionado_at),
      operacion_en_vuelo: enVuelo.has(f.id)
    };
  });
}
