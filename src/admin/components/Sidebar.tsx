import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Calendar, Building2, Tag, Settings } from 'lucide-react';

export function Sidebar() {
  return (
    <aside className="adm-sidebar">
      <nav className="adm-sidebar-nav">
        <SidebarItem to="/admin" end icon={<LayoutDashboard size={18} />} label="Dashboard" />
        <SidebarItem to="/admin/miembros" icon={<Users size={18} />} label="Miembros" />
        <SidebarItem to="/admin/calendario" icon={<Calendar size={18} />} label="Calendario" />
        <SidebarItem to="/admin/recursos" icon={<Building2 size={18} />} label="Estudios" />
        <SidebarItem to="/admin/tiers" icon={<Tag size={18} />} label="Planes" />
        <SidebarItem to="/admin/configuracion" icon={<Settings size={18} />} label="Configuración" />
      </nav>
    </aside>
  );
}

function SidebarItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `adm-sidebar-link ${isActive ? 'adm-sidebar-link--active' : ''}`}
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
