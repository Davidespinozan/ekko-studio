/**
 * Beneficios de un tier (membresía). Formato canónico: { label, incluido }, que
 * permite la tabla "qué incluye / qué no" (✓ / ✗). Antes había tres copias de un
 * parser que descartaba los objetos (solo aceptaba strings) → los beneficios
 * reales se perdían en admin, landing y perfil. Este es el único punto de verdad.
 */

export interface Beneficio {
  label: string;
  incluido: boolean;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Normaliza el campo `beneficios` (jsonb) a `Beneficio[]`. Tolera:
 *   - objetos { label, incluido } (canónico),
 *   - `incluido` ausente → true,
 *   - strings sueltos (legacy) → tratados como incluidos.
 */
export function parseBeneficios(raw: unknown): Beneficio[] {
  const arr = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(arr)) return [];
  const out: Beneficio[] = [];
  for (const b of arr) {
    if (typeof b === 'string') {
      if (b.trim()) out.push({ label: b, incluido: true });
    } else if (b && typeof b === 'object' && typeof (b as { label?: unknown }).label === 'string') {
      const o = b as { label: string; incluido?: unknown };
      out.push({ label: o.label, incluido: o.incluido !== false });
    }
  }
  return out;
}
