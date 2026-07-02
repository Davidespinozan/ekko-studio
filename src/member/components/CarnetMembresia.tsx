import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { ResumenCarnet, TonoEstado } from '@member/logic/carnetMembresia';

// ============================================================================
// CarnetMembresia — "carnet" dorado del Home. Da identidad de socio al Home
// (antes se sentía vacío). El texto ya viene resuelto por resumenCarnet().
// ============================================================================

const DOT_COLOR: Record<TonoEstado, string> = {
  success: 'var(--ek-success)',
  warning: '#e5b829',
  danger: 'var(--ek-danger)',
  neutral: 'rgba(10,10,10,0.5)'
};

interface Props {
  tierNombre: string;
  resumen: ResumenCarnet;
}

export function CarnetMembresia({ tierNombre, resumen }: Props) {
  const { titulo, subtitulo, estadoLabel, estadoTono, requiereAccion } = resumen;

  return (
    <div className="ek-card ek-card--hero ek-card--gold ek-lift" style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <p className="ek-eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0 }}>
          <Sparkles size={13} aria-hidden="true" /> MEMBRESÍA
        </p>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            fontWeight: 600,
            color: 'rgba(10,10,10,0.72)',
            background: 'rgba(10,10,10,0.10)',
            borderRadius: '999px',
            padding: '4px 10px'
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: DOT_COLOR[estadoTono],
              boxShadow: `0 0 8px ${DOT_COLOR[estadoTono]}`
            }}
          />
          {estadoLabel}
        </span>
      </div>

      <h2 className="ek-display-lg" style={{ marginBottom: '10px', textTransform: 'capitalize' }}>
        {tierNombre}
      </h2>

      <p className="ek-body" style={{ margin: 0, fontWeight: 600 }}>{titulo}</p>
      {subtitulo && (
        <p className="ek-body-faint" style={{ marginTop: '4px', marginBottom: 0 }}>{subtitulo}</p>
      )}

      {requiereAccion && (
        <div style={{ marginTop: '18px' }}>
          <Link to="/app/perfil" className="ek-cta">
            Ver planes <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}
