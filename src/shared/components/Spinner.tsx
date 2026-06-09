import { Loader2 } from 'lucide-react';

interface SpinnerProps {
  size?: number;
  /** Texto opcional al lado del spinner (reemplaza los "..." de carga). */
  label?: string;
  className?: string;
}

/**
 * Spinner vectorial real (técnica #2/#10). Sustituye los "…" / "Cargando…"
 * de texto plano por un indicador animado consistente en toda la app.
 */
export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const icon = <Loader2 size={size} className="ek-spin" aria-hidden="true" />;
  if (!label) return icon;
  return (
    <span className={`ek-loading-inline ${className ?? ''}`} role="status">
      {icon}
      {label}
    </span>
  );
}
