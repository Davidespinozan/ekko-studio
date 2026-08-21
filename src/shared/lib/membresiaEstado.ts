/**
 * Estado operativo de una membresía, derivado por FECHA y no solo por status.
 * Lo usan la ficha admin, la ficha de recepción y el check-in: si el cron de
 * expiración se atrasa, el status de la fila miente pero la fecha no.
 */
export type EstadoMembresiaUI = 'vigente' | 'por_vencer' | 'vencida' | 'pago_pendiente' | 'pausada' | 'sin_membresia';

export interface MembresiaParaEstado {
  status: string;
  periodo_actual_fin: string | null;
}

export function estadoMembresia(m: MembresiaParaEstado | null, ahora: Date = new Date()): EstadoMembresiaUI {
  if (!m) return 'sin_membresia';
  if (m.status === 'pausada') return 'pausada';
  if (m.status === 'past_due') return 'pago_pendiente';
  if (m.periodo_actual_fin) {
    const fin = new Date(m.periodo_actual_fin).getTime();
    if (fin < ahora.getTime()) return 'vencida';
    if (fin - ahora.getTime() < 3 * 24 * 60 * 60 * 1000) return 'por_vencer';
  }
  return 'vigente';
}

export const ESTADO_MEMBRESIA_LABEL: Record<EstadoMembresiaUI, { texto: string; color: string }> = {
  vigente: { texto: 'VIGENTE', color: 'var(--ek-success)' },
  por_vencer: { texto: 'POR VENCER', color: 'var(--ek-mustard)' },
  vencida: { texto: 'VENCIDA', color: 'var(--ek-danger)' },
  pago_pendiente: { texto: 'PAGO PENDIENTE', color: 'var(--ek-danger)' },
  pausada: { texto: 'EN PAUSA', color: 'var(--ek-ink-muted)' },
  sin_membresia: { texto: 'SIN MEMBRESÍA', color: 'var(--ek-ink-faint)' }
};

export function esPaqueteDeCreditos(tipo: string | null | undefined): boolean {
  return tipo === 'creditos' || tipo === 'hibrido';
}
