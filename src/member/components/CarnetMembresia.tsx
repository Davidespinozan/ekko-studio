import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { ResumenCarnet, TonoEstado } from '@member/logic/carnetMembresia';

// ============================================================================
// CarnetMembresia — carnet compacto del Home: plan + estado + actividad
// (próximas / este mes / créditos) en UNA sola card. El texto de estado ya
// viene resuelto por resumenCarnet(); el mensaje/CTA solo aparece si requiere
// acción (pago vencido, sin plan, etc.).
// ============================================================================

const DOT_COLOR: Record<TonoEstado, string> = {
  success: 'var(--ek-success)',
  warning: '#e5b829',
  danger: 'var(--ek-danger)',
  neutral: 'rgba(255,255,255,0.4)'
};

interface Props {
  tierNombre: string;
  resumen: ResumenCarnet;
  proximasCount: number;
  sesionesEsteMes: number;
  /** Créditos restantes; null si el plan no es por créditos. */
  creditosRestantes: number | null;
}

export function CarnetMembresia({ tierNombre, resumen, proximasCount, sesionesEsteMes, creditosRestantes }: Props) {
  const { titulo, subtitulo, estadoLabel, estadoTono, requiereAccion } = resumen;

  const stats: Array<{ valor: number; label: string }> = [
    { valor: proximasCount, label: proximasCount === 1 ? 'Próxima' : 'Próximas' },
    { valor: sesionesEsteMes, label: 'Este mes' }
  ];
  if (creditosRestantes !== null) {
    stats.push({ valor: creditosRestantes, label: creditosRestantes === 1 ? 'Crédito' : 'Créditos' });
  }

  return (
    <div className="ek-card ek-carnet ek-lift" style={{ marginBottom: '16px', padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <p className="ek-eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', margin: 0, color: 'var(--ek-mustard)' }}>
          <Sparkles size={13} aria-hidden="true" /> MEMBRESÍA
        </p>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--ek-ink-muted)',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: '999px',
            padding: '4px 10px'
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: DOT_COLOR[estadoTono], boxShadow: `0 0 8px ${DOT_COLOR[estadoTono]}` }} />
          {estadoLabel}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '24px', fontWeight: 700, letterSpacing: '-0.02em', textTransform: 'capitalize', margin: 0, lineHeight: 1 }}>
          {tierNombre}
        </h2>
        <div style={{ display: 'flex', gap: '20px' }}>
          {stats.map((s) => (
            <div key={s.label} style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {s.valor}
              </div>
              <div style={{ fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {requiereAccion && (
        <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '0.5px solid rgba(255,255,255,0.08)' }}>
          <p className="ek-body" style={{ margin: 0, fontWeight: 600 }}>{titulo}</p>
          {subtitulo && <p className="ek-body-faint" style={{ marginTop: '4px', marginBottom: 0 }}>{subtitulo}</p>}
          <div style={{ marginTop: '14px' }}>
            <Link to="/app/perfil" className="ek-cta ek-cta--gold">
              Ver planes <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
