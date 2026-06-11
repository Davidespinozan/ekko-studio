import { NavLink } from 'react-router-dom';
import { LayoutDashboard, CalendarRange, Users, ScanLine } from 'lucide-react';

/**
 * Bottom-nav de recepción (Bloque B/C). 4 ítems, mobile-first (~80% del uso).
 * Reusa las clases `ek-bottom-nav` (mismas que el member, tema oscuro).
 */
export function ReceptionBottomNav() {
  return (
    <nav className="ek-bottom-nav" aria-label="Navegación de recepción">
      <div className="ek-bottom-nav-inner">
        <NavItem to="/recepcion" end icon={<LayoutDashboard size={22} className="ek-bottom-nav-icon" />} label="Hoy" />
        <NavItem to="/recepcion/agenda" icon={<CalendarRange size={22} className="ek-bottom-nav-icon" />} label="Agenda" />
        <NavItem to="/recepcion/miembros" icon={<Users size={22} className="ek-bottom-nav-icon" />} label="Miembros" />
        <NavItem to="/recepcion/checkin" icon={<ScanLine size={22} className="ek-bottom-nav-icon" />} label="Check-in" />
      </div>
    </nav>
  );
}

function NavItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `ek-bottom-nav-item ${isActive ? 'ek-bottom-nav-item--active' : ''}`}
    >
      {icon}
      <span className="ek-bottom-nav-item-label">{label}</span>
    </NavLink>
  );
}
