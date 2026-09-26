/**
 * Búsqueda en mostrador (Hoy y padrón): por nombre, email, folio o TELÉFONO.
 * Lógica pura y compartida para que "no aparece" no dependa de la pantalla.
 *
 *  - Texto: sin acentos ni mayúsculas (José ↔ jose).
 *  - Teléfono: solo dígitos y por "termina en" o "contiene": recepción suele
 *    tener los últimos 4 y el número guardado puede traer +52, espacios o guiones.
 */

export interface PersonaBuscable {
  nombre?: string | null;
  email?: string | null;
  folio?: string | null;
  telefono?: string | null;
}

export function normalizarTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function soloDigitos(s: string): string {
  return s.replace(/\D/g, '');
}

/** ¿La consulta parece un teléfono? ≥3 dígitos y nada más que dígitos, espacios, +, - o paréntesis. */
export function pareceTelefono(q: string): boolean {
  const d = soloDigitos(q);
  return d.length >= 3 && /^[\d\s()+-]+$/.test(q.trim());
}

export function coincideBusqueda(p: PersonaBuscable, consulta: string): boolean {
  const q = normalizarTexto(consulta);
  if (!q) return true;
  if (pareceTelefono(consulta)) {
    const tel = soloDigitos(p.telefono ?? '');
    if (tel && tel.includes(soloDigitos(consulta))) return true;
    // Un folio también puede ser numérico: no lo descartamos.
  }
  return (
    normalizarTexto(p.nombre ?? '').includes(q) ||
    normalizarTexto(p.email ?? '').includes(q) ||
    normalizarTexto(p.folio ?? '').includes(q)
  );
}
