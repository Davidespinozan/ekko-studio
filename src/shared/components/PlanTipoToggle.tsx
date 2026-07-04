/**
 * Selector Membresías mensuales · Paquetes de créditos. Los dos modelos conviven
 * (mensualidad de acceso vs paquete de sesiones); mostrarlos juntos satura, así
 * que se separan por pestaña. Fuente única de verdad para landing, registro
 * (PagarMembresia) y "Cambiar de plan" (MiSuscripcion) → presentación consistente.
 */

export type VistaPlan = 'membresias' | 'paquetes';

interface Props {
  value: VistaPlan;
  onChange: (v: VistaPlan) => void;
}

export function PlanTipoToggle({ value, onChange }: Props) {
  return (
    <div className="ek-plan-toggle" role="tablist" aria-label="Tipo de plan">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'membresias'}
        className={`ek-plan-toggle-btn ${value === 'membresias' ? 'is-active' : ''}`}
        onClick={() => onChange('membresias')}
      >
        Membresías mensuales
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'paquetes'}
        className={`ek-plan-toggle-btn ${value === 'paquetes' ? 'is-active' : ''}`}
        onClick={() => onChange('paquetes')}
      >
        Paquetes de créditos
      </button>
    </div>
  );
}
