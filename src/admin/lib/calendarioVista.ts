export type Vista = 'dia' | 'semana' | 'lista';

export const VISTA_STORAGE_KEY = 'ekko-admin-reservas-vista';
export const MOBILE_BREAKPOINT = 768;

/**
 * Determina la vista inicial del calendario admin.
 *
 * Prioridad:
 *  1. Preferencia guardada en localStorage ('dia' | 'semana' | 'lista').
 *  2. Sin preferencia (o valor legacy 'calendario'): default por viewport
 *     — <768px → 'dia' (mobile), ≥768px → 'semana' (desktop).
 */
export function readVista(): Vista {
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(VISTA_STORAGE_KEY);
    if (v === 'dia' || v === 'semana' || v === 'lista') return v;
  }
  if (typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT) {
    return 'dia';
  }
  return 'semana';
}
