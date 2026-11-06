import { backendPost } from '@shared/lib/backend';
import { ZONA_ESTUDIO } from '@shared/lib/timezone';

/**
 * Planes STRYV (EKKO-149): lo que STRYV le cobra al estudio con su tarjeta en la
 * cuenta de Stripe de STRYV. STRYV Care = mantenimiento e infraestructura del
 * sistema; STRYV Grow = videos con IA para redes. Todo lo decide la function
 * `stryv-care`; aquí solo se consulta y se redirige a las páginas seguras de
 * Stripe. Mismo diseño que Fukuroll y Renovacell.
 */

export type PlanStryv = 'care' | 'grow';

export const ORDEN_PLANES: readonly PlanStryv[] = ['care', 'grow'];

export interface InfoPlan {
  nombre: string;
  /** Segunda palabra de la marca ("Care", "Grow"), que va en color. */
  apellido: string;
  descripcion: string;
  incluye: readonly string[];
  activar: string;
}

/**
 * Lo que incluye cada plan. Care como en Fukuroll (decisión del dueño, 2026-11-05):
 * la infraestructura va dentro del plan. En Renovacell no (la paga Renovacell).
 */
export const PLANES_STRYV: Record<PlanStryv, InfoPlan> = {
  care: {
    nombre: 'STRYV Care',
    apellido: 'Care',
    descripcion: 'Mantenimiento e infraestructura de tu sistema, operado por STRYV.',
    incluye: [
      'Sistema de reservas, app de miembros y página pública siempre en línea',
      'Servidores, base de datos, dominio y certificados de seguridad',
      'Respaldos, monitoreo y corrección de fallas',
      'Ajustes de planes, precios y fotos',
      'Soporte directo con STRYV'
    ],
    activar: 'Activar STRYV Care'
  },
  grow: {
    nombre: 'STRYV Grow',
    apellido: 'Grow',
    descripcion: 'Videos con IA para tus redes, hechos para llevar gente a reservar en tu app.',
    incluye: [
      '15 videos al mes producidos con IA',
      'Escenas de tus propios estudios, con voz y música',
      'Cada video diseñado para llevar gente a reservar en tu app',
      'Listos para publicar en Instagram, TikTok y Facebook'
    ],
    activar: 'Activar STRYV Grow'
  }
};

export type EstadoCare = 'active' | 'trialing' | 'past_due' | 'unpaid' | 'inactivo' | 'no_disponible' | string;

export interface ReciboCare {
  fecha: number;
  monto_centavos: number;
  estado: string | null;
  url: string | null;
}

export interface StatusCare {
  plan?: PlanStryv;
  estado: EstadoCare;
  monto_centavos?: number;
  puede_activar?: boolean;
  proximo_cobro?: number | null;
  termina?: number | null;
  tarjeta?: { marca: string; last4: string } | null;
  recibos?: ReciboCare[];
}

export type ResultadoCare<T> = { ok: true; data: T } | { ok: false; message: string };

export const MENSAJE_FALLO_CARE = 'No pudimos consultar los planes STRYV. Intenta de nuevo.';

async function llamar<T>(action: 'status' | 'checkout' | 'portal', plan: PlanStryv): Promise<ResultadoCare<T>> {
  try {
    return { ok: true, data: await backendPost<T>('stryv-care', { action, plan }) };
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.message ? e.message : MENSAJE_FALLO_CARE };
  }
}

export const stryvPlanes = {
  estado: (plan: PlanStryv) => llamar<StatusCare>('status', plan),
  /** Página segura de Stripe para poner la tarjeta y suscribirse al plan. */
  activar: (plan: PlanStryv) => llamar<{ url?: string }>('checkout', plan),
  /** Portal de Stripe: cambiar tarjeta o descargar recibos del plan. */
  portal: (plan: PlanStryv) => llamar<{ url?: string }>('portal', plan)
};

export type ClientePlanes = typeof stryvPlanes;

/** Navegación a la página segura de Stripe (separada para poder probarla). */
export function irA(url: string): void {
  window.location.href = url;
}

export const STRYV_URL = 'https://stryvstudio.com';

export type TonoCare = 'success' | 'warning' | 'danger' | 'neutral';

export const ESTADO_CARE: Record<string, { tono: TonoCare; texto: string }> = {
  active: { tono: 'success', texto: 'Activo' },
  trialing: { tono: 'success', texto: 'Activo' },
  past_due: { tono: 'warning', texto: 'Pago pendiente' },
  unpaid: { tono: 'danger', texto: 'Sin pagar' },
  inactivo: { tono: 'neutral', texto: 'Sin activar' }
};

export const fechaCare = (ts?: number | null): string =>
  ts
    ? new Date(ts * 1000).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONA_ESTUDIO })
    : '—';

export const pesosCare = (c?: number): string =>
  `$${((c ?? 0) / 100).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export type RegresoCare = 'ok' | 'cancel' | 'volver';

/** Al volver de Stripe la URL trae `?stryv=ok|cancel|volver&plan=care|grow`; cualquier otro valor se ignora. */
export function regresoDeStripe(valor: string | null | undefined): RegresoCare | null {
  return valor === 'ok' || valor === 'cancel' || valor === 'volver' ? valor : null;
}

export function planDeRegreso(valor: string | null | undefined): PlanStryv | null {
  return valor === 'care' || valor === 'grow' ? valor : null;
}
