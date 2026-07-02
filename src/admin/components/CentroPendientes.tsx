import { Link } from 'react-router-dom';
import {
  CalendarX,
  CreditCard,
  Fingerprint,
  UserX,
  CheckCircle2,
  ArrowRight,
  type LucideIcon
} from 'lucide-react';
import { useCentroPendientes } from '../hooks/useCentroPendientes';
import { construirPendientes, totalPendientes, type TonoPendiente } from '../logic/centroPendientes';

// ============================================================================
// CentroPendientes — "Mi bandeja" del admin: los pendientes operativos
// priorizados, cada uno enrutando a donde se resuelve. Idea tomada de
// Renovacell ("el sistema te dice el siguiente pendiente").
// ============================================================================

const ICONOS: Record<string, LucideIcon> = {
  'calendar-x': CalendarX,
  'credit-card': CreditCard,
  fingerprint: Fingerprint,
  'user-x': UserX
};

const TONO_COLOR: Record<TonoPendiente, string> = {
  dang: 'var(--ek-danger)',
  warn: 'var(--ek-mustard)',
  neu: 'var(--ek-ink-muted)'
};
const TONO_SOFT: Record<TonoPendiente, string> = {
  dang: 'var(--ek-danger-soft)',
  warn: 'var(--ek-mustard-soft)',
  neu: 'var(--ek-bg-elevated)'
};

export function CentroPendientes() {
  const { conteo, isLoading } = useCentroPendientes();
  const items = construirPendientes(conteo);
  const total = totalPendientes(conteo);

  if (isLoading) {
    return (
      <section style={{ marginBottom: '32px' }}>
        <div className="ek-skeleton" style={{ height: '20px', width: '140px', marginBottom: '14px' }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          <div className="ek-skeleton" style={{ height: '96px', borderRadius: 'var(--ek-r-md)' }} />
          <div className="ek-skeleton" style={{ height: '96px', borderRadius: 'var(--ek-r-md)' }} />
        </div>
      </section>
    );
  }

  return (
    <section style={{ marginBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px', margin: 0 }}>PENDIENTES</p>
        {total > 0 && (
          <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)' }}>
            {total} {total === 1 ? 'cosa por resolver' : 'cosas por resolver'}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="ek-card ek-card--md" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className="ek-empty-icon ek-empty-icon--neutral" style={{ width: 42, height: 42, margin: 0, flexShrink: 0, color: 'var(--ek-success)' }}>
            <CheckCircle2 size={20} aria-hidden="true" />
          </span>
          <div>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '15px', fontWeight: 600, margin: 0 }}>Todo al día</p>
            <p className="ek-body-faint" style={{ margin: '2px 0 0' }}>No hay pendientes operativos ahora mismo.</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }}>
          {items.map((item) => {
            const Icon = ICONOS[item.icon] ?? CreditCard;
            return (
              <Link
                key={item.key}
                to={item.to}
                className="ek-card ek-card--md ek-card-interactive ek-lift"
                style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', textDecoration: 'none' }}
              >
                <span
                  style={{
                    width: 42,
                    height: 42,
                    flexShrink: 0,
                    borderRadius: '12px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: TONO_SOFT[item.tono],
                    color: TONO_COLOR[item.tono]
                  }}
                >
                  <Icon size={19} aria-hidden="true" />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        fontFamily: 'var(--ek-font-display)',
                        fontSize: '22px',
                        fontWeight: 700,
                        letterSpacing: '-0.02em',
                        lineHeight: 1,
                        color: TONO_COLOR[item.tono]
                      }}
                    >
                      {item.count}
                    </span>
                    <span style={{ fontFamily: 'var(--ek-font-display)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.01em' }}>
                      {item.title}
                    </span>
                  </div>
                  <p className="ek-body-faint" style={{ margin: '4px 0 0', lineHeight: 1.4 }}>{item.detail}</p>
                </div>
                <ArrowRight size={15} className="ek-quick-action-arrow" aria-hidden="true" style={{ marginTop: '4px', flexShrink: 0 }} />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
