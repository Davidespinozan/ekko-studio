import ws from 'ws';
if (!globalThis.WebSocket) {
  (globalThis as any).WebSocket = ws;
}

import type { Handler, HandlerResponse } from '@netlify/functions';
import type Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { ok, badRequest, unauthorized, forbidden } from '../_lib/http';
import { errorInterno } from '../_lib/errores';
import { requireEnv, optionalEnv } from '../_lib/env';
import { getStripe } from '../_lib/stripe';
import { esAdminActivo } from '../_lib/staff';

/**
 * POST /stryv-care — los planes que STRYV le cobra al estudio en SU cuenta de
 * Stripe (la de la plataforma, la misma `STRIPE_SECRET_KEY` que usa Connect):
 *   · STRYV Care: mantenimiento e infraestructura del sistema (como Fukuroll).
 *   · STRYV Grow: videos con IA para redes.
 * Aquí NO interviene la cuenta conectada del estudio: el estudio es el cliente
 * (uno por tenant, compartido por los planes). Mismo diseño que Fukuroll y
 * Renovacell (EKKO-149).
 *
 *   { action: 'status',   plan } → estado de la suscripción, próximo cobro, tarjeta y recibos del plan
 *   { action: 'checkout', plan } → página segura de Stripe para poner la tarjeta y suscribirse → { url }
 *   { action: 'portal',   plan } → portal de Stripe para cambiar tarjeta o descargar recibos → { url }
 *   `plan` = 'care' (default) | 'grow'.
 *
 * Auth: Bearer JWT del ADMIN ACTIVO del estudio. Producto, precio (lookup_key
 * estable) y configuración del portal se crean solos la primera vez, con llaves
 * de idempotencia; sin pasos manuales en el panel de Stripe.
 *
 * No toca la base de EKKO ni sus derechos: todo vive en Stripe. Sus objetos llevan
 * `metadata.app = 'stryv-care' | 'stryv-grow'`, que el webhook de EKKO descarta
 * (`app_ajena`, EKKO-019).
 */

export type PlanId = 'care' | 'grow';

export interface PlanStryv {
  id: PlanId;
  /** `metadata.app` de todo lo que crea este plan en Stripe. */
  app: string;
  nombre: string;
  envPrecio: string;
  precioDefault: number;
  /** Encabezado de la configuración propia del portal de este plan. */
  headline: string;
}

export const PLANES: Record<PlanId, PlanStryv> = {
  care: {
    id: 'care',
    app: 'stryv-care',
    nombre: 'STRYV Care',
    envPrecio: 'STRYV_CARE_CENTAVOS',
    precioDefault: 250000, // $2,500 MXN al mes (igual que Fukuroll: con infraestructura)
    headline: 'STRYV Care · mantenimiento e infraestructura'
  },
  grow: {
    id: 'grow',
    app: 'stryv-grow',
    nombre: 'STRYV Grow',
    envPrecio: 'STRYV_GROW_CENTAVOS',
    precioDefault: 650000, // $6,500 MXN al mes
    headline: 'STRYV Grow · videos con IA para tus redes'
  }
};

/** El cliente de Stripe es el ESTUDIO: uno por tenant, compartido por los planes. */
const APP_CLIENTE = 'stryv-care';
const RUTA_REGRESO = '/admin/stryv';
const MENSAJE_FALLO = 'No pudimos consultar los planes STRYV. Intenta de nuevo.';
/** Suscripciones que cuentan como "ya tiene el plan" (`incomplete` no: la alta no terminó). */
const VIVAS: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'unpaid']);
const ACCIONES: ReadonlySet<string> = new Set(['status', 'checkout', 'portal']);

export function planDesde(valor: unknown): PlanStryv | null {
  if (valor === undefined || valor === null) return PLANES.care;
  return valor === 'care' || valor === 'grow' ? PLANES[valor] : null;
}

/** Precio mensual en centavos: la variable del plan si es un entero positivo; si no, el default. */
export function precioCentavos(plan: PlanStryv): number {
  const n = Number(optionalEnv(plan.envPrecio, ''));
  return Number.isInteger(n) && n > 0 ? n : plan.precioDefault;
}

export const lookupKey = (plan: PlanStryv, centavos: number): string => `stryv_${plan.id}_mxn_mensual_${centavos}`;

/**
 * El cliente de Stripe se identifica por el slug del estudio (la misma cuenta
 * atiende a varios sistemas de STRYV). Solo `[a-z0-9_-]`: va dentro de la
 * consulta de búsqueda de Stripe.
 */
export function claveTenant(slug: string | null | undefined): string | null {
  return typeof slug === 'string' && /^[a-z0-9_-]{1,64}$/.test(slug) ? slug : null;
}

async function precio(stripe: Stripe, plan: PlanStryv, centavos: number): Promise<string> {
  const key = lookupKey(plan, centavos);
  const ya = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  if (ya.data[0]) return ya.data[0].id;
  const p = await stripe.prices.create(
    {
      currency: 'mxn',
      unit_amount: centavos,
      recurring: { interval: 'month' },
      lookup_key: key,
      product_data: { name: plan.nombre, metadata: { app: plan.app } },
      metadata: { app: plan.app }
    },
    { idempotencyKey: `stryv-care-price-${key}` }
  );
  return p.id;
}

/**
 * Configuración PROPIA del portal por plan (no la predeterminada de la cuenta,
 * que usan otras apps de STRYV): solo cambiar tarjeta y ver/descargar recibos.
 * Se crea una vez y se reutiliza (se identifica por metadata).
 */
async function portalConfig(stripe: Stripe, plan: PlanStryv): Promise<string> {
  const l = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const ya = l.data.find((c) => c.metadata?.app === plan.app);
  if (ya) return ya.id;
  const c = await stripe.billingPortal.configurations.create({
    business_profile: { headline: plan.headline },
    features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
    metadata: { app: plan.app }
  });
  return c.id;
}

async function cliente(
  stripe: Stripe,
  tenant: string,
  crear: boolean,
  email: string | null,
  nombre: string
): Promise<Stripe.Customer | null> {
  const r = await stripe.customers.search({ query: `metadata['stryv_care_tenant']:'${tenant}'`, limit: 1 });
  if (r.data[0]) return r.data[0];
  if (!crear) return null;
  return await stripe.customers.create(
    { name: nombre, email: email ?? undefined, metadata: { app: APP_CLIENTE, stryv_care_tenant: tenant, tenant } },
    { idempotencyKey: `stryv-care-customer-${tenant}` }
  );
}

/** La suscripción viva DE ESTE plan (el cliente puede tener varias: una por plan). */
export function suscripcionDelPlan(subs: Array<{ status: string; metadata?: { app?: string } | null }>, plan: PlanStryv) {
  return subs.find((x) => VIVAS.has(x.status) && x.metadata?.app === plan.app) ?? null;
}

/** Fin del periodo en curso (segundos Unix). En la API fijada vive en los items; se respalda en el campo viejo. */
export function finPeriodo(sub: unknown): number | null {
  if (!sub) return null;
  const s = sub as { current_period_end?: number; items?: { data?: Array<{ current_period_end?: number }> } };
  const ts = s.items?.data?.[0]?.current_period_end ?? s.current_period_end;
  return typeof ts === 'number' ? ts : null;
}

const conflicto = (error: string): HandlerResponse => ({
  statusCode: 409,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error })
});

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return badRequest('Method not allowed');

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) return unauthorized('Falta el token');
    const userToken = authHeader.slice('Bearer '.length);

    let body: { action?: unknown; plan?: unknown } = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return badRequest('Body inválido');
    }
    const action = typeof body.action === 'string' ? body.action : 'status';
    if (!ACCIONES.has(action)) return badRequest('Acción inválida');
    const plan = planDesde(body.plan);
    if (!plan) return badRequest('Plan inválido');

    const supabaseUrl = requireEnv('VITE_SUPABASE_URL');
    const anonKey = requireEnv('VITE_SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
      auth: { persistSession: false }
    });
    const { data: { user: authUser }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !authUser) return unauthorized('Token inválido');

    const { data: admin } = await asUser
      .from('usuarios')
      .select('tenant_id, rol, status')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (!admin?.tenant_id) return forbidden('No encontramos tu cuenta');
    if (!esAdminActivo(admin)) return forbidden('Solo el admin del estudio puede ver los planes STRYV');

    // Sin llave de Stripe no hay nada que consultar ni activar: la pantalla lo dice.
    if (!process.env.STRIPE_SECRET_KEY) return ok({ plan: plan.id, estado: 'no_disponible' });

    const adminDb = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: tenant } = await adminDb
      .from('tenants')
      .select('slug, nombre')
      .eq('id', admin.tenant_id)
      .maybeSingle();
    const tenantKey = claveTenant(tenant?.slug);
    if (!tenantKey) return forbidden('No encontramos tu estudio');
    const nombre = (tenant?.nombre as string | null | undefined) || 'Estudio';

    const centavos = precioCentavos(plan);
    const stripe = getStripe();
    const origin =
      event.headers.origin ||
      event.headers.referer?.replace(/\/+$/, '') ||
      optionalEnv('URL', '');
    const regreso = (q: 'ok' | 'cancel' | 'volver') => `${origin}${RUTA_REGRESO}?stryv=${q}&plan=${plan.id}`;

    if (action === 'checkout' || action === 'portal') {
      const c = await cliente(stripe, tenantKey, true, authUser.email ?? null, nombre);
      if (!c) return errorInterno('stryv-care', new Error('customer_no_creado'), MENSAJE_FALLO);

      if (action === 'portal') {
        const s = await stripe.billingPortal.sessions.create({
          customer: c.id,
          configuration: await portalConfig(stripe, plan),
          return_url: regreso('volver')
        });
        return ok({ url: s.url });
      }

      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 20 });
      if (suscripcionDelPlan(subs.data, plan)) return conflicto(`${plan.nombre} ya está activo.`);
      const s = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: c.id,
        line_items: [{ price: await precio(stripe, plan, centavos), quantity: 1 }],
        subscription_data: { metadata: { app: plan.app, stryv_plan: plan.id, stryv_care_tenant: tenantKey } },
        metadata: { app: plan.app, stryv_plan: plan.id, stryv_care_tenant: tenantKey },
        locale: 'es',
        success_url: regreso('ok'),
        cancel_url: regreso('cancel')
      });
      return ok({ url: s.url });
    }

    // status
    const base = { plan: plan.id, estado: 'inactivo', monto_centavos: centavos, puede_activar: true };
    const c = await cliente(stripe, tenantKey, false, null, nombre);
    if (!c) return ok(base);

    const subs = await stripe.subscriptions.list({
      customer: c.id,
      status: 'all',
      limit: 20,
      expand: ['data.default_payment_method']
    });
    const sub = suscripcionDelPlan(subs.data, plan) as Stripe.Subscription | null;
    const pm = sub?.default_payment_method ?? null;
    const card = pm && typeof pm === 'object' ? (pm as Stripe.PaymentMethod).card ?? null : null;

    // Recibos DE ESTE plan (el cliente comparte los planes): solo los de su suscripción
    // viva. Son informativos: si Stripe falla en esto, el resto del estado igual se devuelve.
    let recibos: Array<{ fecha: number; monto_centavos: number; estado: string | null; url: string | null }> = [];
    if (sub) {
      try {
        const inv = await stripe.invoices.list({ customer: c.id, subscription: sub.id, limit: 6 });
        recibos = inv.data.map((i) => ({
          fecha: i.created,
          monto_centavos: i.amount_paid || i.amount_due,
          estado: i.status ?? null,
          url: i.hosted_invoice_url ?? null
        }));
      } catch (e) {
        console.error('[stryv-care] invoices', e instanceof Error ? e.message : e);
      }
    }

    const fin = finPeriodo(sub);
    return ok({
      ...base,
      estado: sub ? sub.status : 'inactivo',
      proximo_cobro: sub && !sub.cancel_at_period_end ? fin : null,
      termina: sub?.cancel_at_period_end ? fin : null,
      tarjeta: card ? { marca: card.brand, last4: card.last4 } : null,
      recibos
    });
  } catch (err) {
    console.error('[stryv-care]', err instanceof Error ? err.message : err);
    return errorInterno('stryv-care', err, MENSAJE_FALLO);
  }
};
