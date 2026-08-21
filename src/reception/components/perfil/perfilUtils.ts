import { ZONA_ESTUDIO } from '@shared/lib/timezone';
// Helpers de formato del perfil de miembro (recepción).

export function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', { timeZone: ZONA_ESTUDIO,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { timeZone: ZONA_ESTUDIO,
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

/** Nombre para mostrar: nombre capitalizado o, si falta, el email. */
export function nombreMostrado(nombre: string | null, email: string): string {
  return capitalizar(nombre) || email;
}

export function iniciales(nombre: string | null, email: string): string {
  const base = (nombre ?? email ?? '?').trim();
  const parts = base.split(/[\s@.]+/).filter(Boolean).slice(0, 2);
  const ini = parts.map((p) => p[0]?.toUpperCase() ?? '').join('');
  return ini || '?';
}
