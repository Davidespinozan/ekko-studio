import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@shared/hooks/useAuth';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: 'OPERACIÓN',
    items: [
      {
        to: '/admin',
        label: 'Dashboard',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        )
      },
      {
        to: '/admin/miembros',
        label: 'Miembros',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        )
      },
      {
        to: '/admin/calendario',
        label: 'Reservas',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        )
      }
    ]
  },
  {
    label: 'CATÁLOGO',
    items: [
      {
        to: '/admin/recursos',
        label: 'Estudios',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
        )
      },
      {
        to: '/admin/tiers',
        label: 'Planes',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
            <line x1="7" y1="7" x2="7.01" y2="7" />
          </svg>
        )
      }
    ]
  },
  {
    label: 'AJUSTES',
    items: [
      {
        to: '/admin/configuracion',
        label: 'Configuración',
        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        )
      }
    ]
  }
];

interface Props {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: Props = {}) {
  const { usuario, signOut } = useAuth();
  const navigate = useNavigate();

  const nombreFormat =
    usuario?.nombre
      ?.toLowerCase()
      .split(' ')
      .filter(Boolean)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') ?? '';

  return (
    <aside className="adm-sidebar">
      <div className="adm-sidebar-brand">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '20px',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              color: 'var(--ek-mustard)'
            }}
          >
            EKKO
          </span>
          <span className="ek-eyebrow" style={{ fontSize: '10px' }}>STUDIO</span>
        </div>
        <span
          className="ek-badge"
          style={{
            marginTop: '8px',
            backgroundColor: 'var(--ek-mustard)',
            color: 'var(--ek-bg)',
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            padding: '4px 10px',
            alignSelf: 'flex-start',
            width: 'fit-content'
          }}
        >
          ADMIN
        </span>
      </div>

      <nav className="adm-sidebar-nav">
        {SECTIONS.map((section) => (
          <div key={section.label} className="adm-sidebar-section">
            <p className="ek-eyebrow adm-sidebar-section-label">{section.label}</p>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/admin'}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `adm-sidebar-item ${isActive ? 'adm-sidebar-item--active' : ''}`
                }
              >
                <span className="adm-sidebar-item-icon">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="adm-sidebar-footer">
        <div style={{ marginBottom: '12px' }}>
          <p className="ek-eyebrow" style={{ fontSize: '9px', marginBottom: '4px' }}>
            CONECTADO
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
              color: 'var(--ek-ink)'
            }}
          >
            {nombreFormat || usuario?.email}
          </p>
        </div>
        <button
          onClick={() => {
            signOut();
            navigate('/login');
          }}
          className="ek-icon-btn"
          style={{
            width: '100%',
            padding: '10px',
            fontSize: '13px',
            textAlign: 'center'
          }}
        >
          Cerrar sesión →
        </button>
      </div>
    </aside>
  );
}
