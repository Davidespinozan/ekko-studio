import type { CSSProperties } from 'react';

interface PlanChipProps {
  /** slug del plan del miembro (ej. 'creador'). null/'' = sin plan. */
  slug: string | null | undefined;
  style?: CSSProperties;
  className?: string;
}

/**
 * Chip con el plan del miembro (paquete de créditos). Reemplaza al viejo
 * TierBadge Pro/Básica, que ya no aplica en el modelo de créditos: los planes
 * ahora son paquetes (Starter, Creador, etc.), no niveles Pro/Básica.
 *
 * Muestra el slug formateado (no depende de una query). Los slugs son legibles
 * ("creador" → "Creador", "sesion-suelta" → "Sesion suelta").
 */
export function PlanChip({ slug, style, className }: PlanChipProps) {
  const label = slug
    ? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ')
    : 'Sin plan';
  return (
    <span className={`ek-badge ek-badge--neutral ${className ?? ''}`} style={style}>
      {label}
    </span>
  );
}
