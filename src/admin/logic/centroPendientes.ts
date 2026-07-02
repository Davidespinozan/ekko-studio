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

  if (c.membresiasVencidas > 0) {
    items.push({
      key: 'vencidas',
      icon: 'calendar-x',
      title: c.membresiasVencidas === 1 ? 'Membresía vencida' : 'Membresías vencidas',
      detail: 'Periodo terminado y siguen activas. Renová o suspendé.',
      count: c.membresiasVencidas,
      tono: 'dang',
      to: '/admin/miembros'
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
      to: '/admin/cobros'
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
      to: '/admin/miembros'
    });
  }
  if (c.noShows7d > 0) {
    items.push({
      key: 'noshow',
      icon: 'user-x',
      title: c.noShows7d === 1 ? 'No-show reciente' : 'No-shows recientes',
      detail: 'Inasistencias de los últimos 7 días. Revisá si aplica sanción.',
      count: c.noShows7d,
      tono: 'neu',
      to: '/admin/calendario'
    });
  }

  const peso: Record<TonoPendiente, number> = { dang: 0, warn: 1, neu: 2 };
  return items.sort((a, b) => peso[a.tono] - peso[b.tono] || b.count - a.count);
}

export function totalPendientes(c: ConteoPendientes): number {
  return c.cobrosPendientes + c.identidadPendiente + c.membresiasVencidas + c.noShows7d;
}
