import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { BottomNav } from './components/BottomNav';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reservar = lazy(() => import('./pages/Reservar'));
const Historial = lazy(() => import('./pages/Historial'));
const Perfil = lazy(() => import('./pages/Perfil'));
const MiQR = lazy(() => import('./pages/MiQR'));

export default function MemberLayout() {
  const tenant = useTenant();
  const { authUser, isLoading, signOut } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;

  return (
    <div className="ek-page" style={{ paddingBottom: '88px' /* espacio para bottom nav */ }}>
      <header
        style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--ek-line)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--ek-cream)',
          position: 'sticky',
          top: 0,
          zIndex: 10
        }}
      >
        <Link to="/app" style={{ fontWeight: 700, fontSize: '1.125rem' }}>
          {tenant.nombre}
        </Link>
        <button onClick={signOut} style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
          Salir
        </button>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/reservar" element={<Reservar />} />
          <Route path="/historial" element={<Historial />} />
          <Route path="/perfil" element={<Perfil />} />
          <Route path="/qr/:reservaId" element={<MiQR />} />
        </Routes>
      </Suspense>

      <BottomNav />
    </div>
  );
}
