import { CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Tone = 'success' | 'danger' | 'warning' | 'neutral';

interface StatusMeta {
  texto: string;
  tone: Tone;
  icon: LucideIcon;
}

/**
 * Mapa único de estados de reserva → etiqueta + tono + icono Lucide.
 * Reemplaza los mapas ad-hoc con glifos (✓ ✕ ⚠) repartidos por admin,
 * member y recepción. Coherente con shared/constants/reservaStatus.ts.
 */
export const RESERVA_STATUS_META: Record<string, StatusMeta> = {
  confirmada: { texto: 'Confirmada', tone: 'success', icon: CheckCircle2 },
  completada: { texto: 'Completada', tone: 'success', icon: CheckCircle2 },
  cancelada: { texto: 'Cancelada por el miembro', tone: 'danger', icon: XCircle },
  cancelada_admin: { texto: 'Cancelada por admin', tone: 'danger', icon: XCircle },
  no_show: { texto: 'No-show', tone: 'warning', icon: AlertTriangle },
  pendiente: { texto: 'Pendiente', tone: 'neutral', icon: Clock }
};

const TONE_CLASS: Record<Tone, string> = {
  success: 'ek-badge--success',
  danger: 'ek-badge--danger',
  warning: 'ek-badge--outline',
  neutral: 'ek-badge--neutral'
};

interface StatusBadgeProps {
  status: string;
  /** Sobrescribe la etiqueta del mapa (ej. texto corto). */
  label?: string;
  size?: number;
}

/**
 * Badge de estado de reserva consistente (técnica #7): pill tonal + icono
 * Lucide + texto. Usar en lugar de pintar dots/colores a mano.
 */
export function StatusBadge({ status, label, size = 13 }: StatusBadgeProps) {
  const meta = RESERVA_STATUS_META[status] ?? RESERVA_STATUS_META.pendiente;
  const Icon = meta.icon;
  return (
    <span className={`ek-badge ${TONE_CLASS[meta.tone]}`}>
      <Icon size={size} aria-hidden="true" />
      {label ?? meta.texto}
    </span>
  );
}
