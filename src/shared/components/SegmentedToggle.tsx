// ============================================================================
// SegmentedToggle — control segmentado reutilizable (mostaza activo / apagado).
// Reemplaza los toggles hechos a mano e inline de recepción (Agenda, Buscar).
// ============================================================================

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Ocupa todo el ancho, con los botones repartidos por igual. */
  block?: boolean;
}

export function SegmentedToggle<T extends string>({ options, value, onChange, ariaLabel, block }: Props<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={`ek-segmented${block ? ' ek-segmented--block' : ''}`}>
      {options.map((o) => {
        const activa = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={activa}
            className={`ek-segmented-btn ${activa ? 'ek-segmented-btn--active' : ''}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
