import { Routes, Route, Link } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { useAdminGuard } from './hooks/useAdminGuard';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { Sidebar } from './components/Sidebar';

const Dashboard = lazy(() => import('./pages/AdminDashboard'));
const Miembros = lazy(() => import('./pages/Miembros'));
const MiembroDetalle = lazy(() => import('./pages/MiembroDetalle'));
const Calendario = lazy(() => import('./pages/Calendario'));
const Recursos = lazy(() => import('./pages/Recursos'));
const Tiers = lazy(() => import('./pages/Tiers'));
const Configuracion = lazy(() => import('./pages/Configuracion'));

export default function AdminLayout() {
  const { isLoading } = useAdminGuard();
  const { signOut, usuario } = useAuth();
  const tenant = useTenant();

  if (isLoading) return <LoadingScreen />;

  return (
    <div className="adm-shell">
      <header className="adm-topbar">
        <Link to="/admin" className="adm-brand">
          {tenant.nombre} <span className="adm-brand-tag">Admin</span>
        </Link>
        <div className="adm-topbar-right">
          <span className="adm-user-label">{usuario?.nombre ?? usuario?.email}</span>
          <button onClick={signOut} className="adm-link-btn">Salir</button>
        </div>
      </header>

      <div className="adm-body">
        <Sidebar />
        <main className="adm-main">
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/miembros" element={<Miembros />} />
              <Route path="/miembros/:id" element={<MiembroDetalle />} />
              <Route path="/calendario" element={<Calendario />} />
              <Route path="/recursos" element={<Recursos />} />
              <Route path="/tiers" element={<Tiers />} />
              <Route path="/configuracion" element={<Configuracion />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
