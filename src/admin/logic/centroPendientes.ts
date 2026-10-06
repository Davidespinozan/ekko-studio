// ============================================================================
// centroPendientes — arma la lista priorizada de pendientes operativos del
// admin a partir de conteos crudos. Cada pendiente enruta a donde se resuelve
// ("el sistema te dice el siguiente pendiente", patrón tomado de Renovacell).
// Pura para testearla sin datos ni UI.
// ============================================================================

export type TonoPendiente = 'warn' | 'dang' | 'neu';

export interface ConteoPendientes {
  cobrosPendientes: number;
  identidadPendiente: number;
  membresiasVencidas: number;
  noShows7d: number;
  materialPendiente: number;
  /** PKG-03A: filas de `v_pendientes_operativos` (revisiones, Stripe, cobro, entrega, divergencias). */
  operacion: number;
}

export interface ItemPendiente {
  key: string;
  /** Nombre del icono lucide (lo resuelve la UI). */
  icon: string;
  title: string;
  detail: string;
  count: number;
  tono: TonoPendiente;
  to: string;
}

/**
 * Devuelve solo los pendientes con count > 0, ordenados por severidad
 * (danger antes que warn antes que neutral) y luego por cantidad.
 */
export function construirPendientes(c: ConteoPendientes): ItemPendiente[] {
  const items: ItemPendiente[] = [];

  if (c.operacion > 0) {
    items.push({
      key: 'operacion',
      icon: 'alert-triangle',
      title: c.operacion === 1 ? 'Pendiente operativo' : 'Pendientes operativos',
      detail: 'Revisiones de cobro, eventos de Stripe, correos fallidos o divergencias que necesitan una decisión.',
      count: c.operacion,
      tono: 'dang',
      to: '/admin/operacion'
    });
  }

  if (c.membresiasVencidas > 0) {
    items.push({
      key: 'vencidas',
      icon: 'calendar-x',
      title: c.membresiasVencidas === 1 ? 'Membresía vencida' : 'Membresías vencidas',
      detail: 'Periodo terminado y siguen activas. Renueva o suspende.',
      count: c.membresiasVencidas,
      tono: 'dang',
      to: '/admin/miembros?filtro=vencidas'
    });
  }
  if (c.cobrosPendientes > 0) {
    items.push({
      key: 'cobros',
      icon: 'credit-card',
      title: c.cobrosPendientes === 1 ? 'Cobro pendiente' : 'Cobros pendientes',
      detail: 'Miembros que aún no completan el pago de su plan.',
      count: c.cobrosPendientes,
      tono: 'warn',
      // A la lista de QUIÉNES son, no a /admin/cobros (eso es la conexión con Stripe).
      to: '/admin/miembros?status=pendiente_pago'
    });
  }
  if (c.identidadPendiente > 0) {
    items.push({
      key: 'identidad',
      icon: 'fingerprint',
      title: c.identidadPendiente === 1 ? 'Identidad por capturar' : 'Identidades por capturar',
      detail: 'Con acceso pero sin ficha completa (foto / INE / contrato).',
      count: c.identidadPendiente,
      tono: 'warn',
      to: '/admin/miembros?filtro=identidad'
    });
  }
  if (c.noShows7d > 0) {
    items.push({
      key: 'noshow',
      icon: 'user-x',
      title: c.noShows7d === 1 ? 'No-show reciente' : 'No-shows recientes',
      detail: 'Inasistencias de los últimos 7 días. Revisa si aplica sanción.',
      count: c.noShows7d,
      tono: 'neu',
      to: '/admin/calendario'
    });
  }
  if (c.materialPendiente > 0) {
    items.push({
      key: 'material',
      icon: 'file-video',
      title: c.materialPendiente === 1 ? 'Sesión sin material' : 'Sesiones sin material',
      detail: 'Ya pasaron y el estudio todavía no sube ni archivo ni enlace.',
      count: c.materialPendiente,
      tono: 'warn',
      to: '/admin/miembros?filtro=material_pendiente'
    });
  }

  const peso: Record<TonoPendiente, number> = { dang: 0, warn: 1, neu: 2 };
  return items.sort((a, b) => peso[a.tono] - peso[b.tono] || b.count - a.count);
}

export function totalPendientes(c: ConteoPendientes): number {
  return c.cobrosPendientes + c.identidadPendiente + c.membresiasVencidas + c.noShows7d + c.materialPendiente + c.operacion;
}
