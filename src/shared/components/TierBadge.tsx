import { Star } from 'lucide-react';
import type { CSSProperties } from 'react';

interface TierBadgeProps {
  /** true = PRO (con estrella), false = BÁSICA. */
  pro: boolean;
  /** Etiqueta extra opcional (ej. "· RECOMENDADA"). */
  suffix?: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * Badge de tier unificado (técnica #2/#7). Reemplaza el `★ PRO` de glifo
 * repetido en member, public y recepción por un icono Lucide consistente.
 */
export function TierBadge({ pro, suffix, style, className }: TierBadgeProps) {
  return (
    <span
      className={`ek-badge ${pro ? 'ek-badge--outline' : ''} ${className ?? ''}`}
      style={style}
    >
      {pro && <Star size={11} fill="currentColor" aria-hidden="true" />}
      {pro ? 'PRO' : 'BÁSICA'}
      {suffix}
    </span>
  );
}
