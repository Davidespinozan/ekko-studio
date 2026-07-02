import { Link } from 'react-router-dom';
import { CalendarDays, Activity, Sparkles, Ticket } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResumenCarnet, TonoEstado } from '@member/logic/carnetMembresia';

// ============================================================================
// ResumenHome — fila compacta de tarjetas del inicio (estilo SALA, tema oscuro):
// Próximas · Sesiones · Membresía · Créditos. La membresía es UNA tarjeta más
// (link al perfil); si requiere acción se resalta. Sin bloques grandes.
// ============================================================================

const DOT: Record<TonoEstado, string> = {
  success: 'var(--ek-success)',
  warning: '#e5b829',
  danger: 'var(--ek-danger)',
  neutral: 'var(--ek-ink-faint)'
};

interface Props {
  tierNombre: string;
  carnet: ResumenCarnet;
  proximasCount: number;
  sesionesEsteMes: number;
  /** Créditos restantes; null si el plan no es por créditos. */
  creditosRestantes: number | null;
}

function Tarjeta({
  Icon,
  valor,
  label,
  dot,
  to,
  acento
}: {
  Icon: LucideIcon;
  valor: string | number;
  label: string;
  dot?: string;
  to?: string;
  acento?: boolean;
}) {
  const contenido = (
    <>
      <Icon size={16} aria-hidden="true" style={{ color: 'var(--ek-ink-faint)', marginBottom: '10px' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        {dot && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, boxShadow: `0 0 8px ${dot}`, flexShrink: 0 }} />}
        <span
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: typeof valor === 'number' ? '26px' : '18px',
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            textTransform: typeof valor === 'number' ? 'none' : 'capitalize',
            color: 'var(--ek-ink)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {valor}
        </span>
      </div>
      <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', marginTop: '7px' }}>
        {label}
      </div>
    </>
  );

  const style: React.CSSProperties = {
    padding: '15px 16px',
    display: 'flex',
    flexDirection: 'column',
    textDecoration: 'none',
    color: 'inherit',
    ...(acento ? { borderColor: 'var(--ek-mustard-dim)' } : null)
  };

  return to ? (
    <Link to={to} className="ek-stat-card ek-card-interactive" style={style}>{contenido}</Link>
  ) : (
    <div className="ek-stat-card" style={style}>{contenido}</div>
  );
}

export function ResumenHome({ tierNombre, carnet, proximasCount, sesionesEsteMes, creditosRestantes }: Props) {
  const sinPlan = carnet.requiereAccion;
  const conCreditos = creditosRestantes !== null;
  // 4 tarjetas (con créditos) → 2×2; 3 tarjetas → fila de 3.
  const columnas = conCreditos ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: columnas, gap: '10px', marginBottom: '20px' }}>
      <Tarjeta Icon={CalendarDays} valor={proximasCount} label={proximasCount === 1 ? 'Próxima' : 'Próximas'} />
      <Tarjeta Icon={Activity} valor={sesionesEsteMes} label="Este mes" />
      <Tarjeta
        Icon={Sparkles}
        valor={sinPlan ? carnet.estadoLabel : tierNombre}
        label="Membresía"
        dot={DOT[carnet.estadoTono]}
        to="/app/perfil"
        acento={sinPlan}
      />
      {conCreditos && (
        <Tarjeta Icon={Ticket} valor={creditosRestantes!} label={creditosRestantes === 1 ? 'Crédito' : 'Créditos'} />
      )}
    </div>
  );
}
