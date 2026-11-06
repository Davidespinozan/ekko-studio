import { partesEnZona, formatFechaEnZona } from './timezone';

/**
 * Bienvenida del panel (admin y recepción), patrón de Renovacell y Fukuroll:
 * saludo según la hora DEL ESTUDIO (no del navegador), nombre de pila si la
 * cuenta es una persona, rol con la fecha y un resumen del día en una línea.
 * Funciones puras para poder probarlas con una hora fija.
 */

export function saludoPorHora(hora: number): string {
  if (hora >= 5 && hora < 12) return 'Buenos días';
  if (hora >= 12 && hora < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Cuentas de servicio o nombres que no son una persona: saludo neutro, sin "tutearlas". */
const NO_PERSONA = new Set(['admin', 'administracion', 'administración', 'recepcion', 'recepción', 'mostrador', 'equipo', 'staff', 'ekko', 'demo', 'test', 'prueba']);

/** Nombre de pila con mayúscula inicial, o null si la cuenta no parece una persona. */
export function nombrePersona(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || /[@_\d]/.test(s)) return null;
  const primero = s.split(/\s+/)[0];
  if (NO_PERSONA.has(primero.toLowerCase())) return null;
  return primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase();
}

export function inicialDe(nombre: string | null, respaldo = 'E'): string {
  return nombre ? nombre.charAt(0).toUpperCase() : respaldo;
}

export function saludo(nombre: string | null | undefined, ahora: Date = new Date()): string {
  const base = saludoPorHora(partesEnZona(ahora).hour);
  const persona = nombrePersona(nombre);
  return persona ? `${base}, ${persona}` : base;
}

export function fechaLarga(ahora: Date = new Date()): string {
  return formatFechaEnZona(ahora, { weekday: 'long', day: 'numeric', month: 'long' });
}

export const ROL_LABEL: Record<string, string> = {
  admin: 'Administración',
  recepcionista: 'Recepción',
  miembro: 'Miembro'
};

export function etiquetaRol(rol: string | null | undefined): string {
  return ROL_LABEL[rol ?? ''] ?? 'Equipo';
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

/**
 * Una línea honesta sobre el día. Lo pendiente manda (y se marca urgente); si no
 * hay pendientes, cuántas sesiones hay hoy (y cuántos check‑ins, en recepción).
 */
export function resumenDelDia(opts: { sesionesHoy: number; pendientes?: number; checkIns?: number | null }): { texto: string; urgente: boolean } {
  const pendientes = opts.pendientes ?? 0;
  if (pendientes > 0) {
    return {
      texto: `Tienes ${pendientes} ${plural(pendientes, 'pendiente que requiere', 'pendientes que requieren')} tu atención.`,
      urgente: true
    };
  }
  if (opts.sesionesHoy > 0) {
    const sesiones = `Hoy hay ${opts.sesionesHoy} ${plural(opts.sesionesHoy, 'sesión agendada', 'sesiones agendadas')}`;
    if (opts.checkIns != null) {
      return { texto: `${sesiones} y ${opts.checkIns} ${plural(opts.checkIns, 'check‑in hecho', 'check‑ins hechos')}.`, urgente: false };
    }
    return { texto: `${sesiones}.`, urgente: false };
  }
  return { texto: 'Hoy no hay sesiones agendadas. Aquí verás todo en cuanto lleguen.', urgente: false };
}
