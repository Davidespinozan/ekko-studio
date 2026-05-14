import { NavLink } from 'react-router-dom';
import { Home, Calendar, ListChecks, User } from 'lucide-react';

export function BottomNav() {
  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'var(--ek-cream)',
        borderTop: '1px solid var(--ek-line)',
        paddingTop: '0.5rem',
        paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
        display: 'flex',
        justifyContent: 'space-around',
        zIndex: 50
      }}
    >
      <NavItem to="/app" end icon={<Home size={20} />} label="Inicio" />
      <NavItem to="/app/reservar" icon={<Calendar size={20} />} label="Reservar" />
      <NavItem to="/app/historial" icon={<ListChecks size={20} />} label="Historial" />
      <NavItem to="/app/perfil" icon={<User size={20} />} label="Perfil" />
    </nav>
  );
}

function NavItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      style={({ isActive }) => ({
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        padding: '8px 12px',
        minWidth: '56px',
        minHeight: '44px',
        color: isActive ? 'var(--ek-black)' : 'var(--ek-ink-muted)',
        fontWeight: isActive ? 600 : 400,
        fontSize: '0.6875rem',
        textDecoration: 'none'
      })}
    >
      {icon}
      {label}
    </NavLink>
  );
}
