import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { BottomNav } from './components/BottomNav';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Reservar = lazy(() => import('./pages/Reservar'));
const Historial = lazy(() => import('./pages/Historial'));
const Perfil = lazy(() => import('./pages/Perfil'));
const MiQR = lazy(() => import('./pages/MiQR'));

export default function MemberLayout() {
  const { authUser, isLoading, signOut } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;

  return (
    <div className="ek-page" style={{ paddingBottom: '88px' /* espacio para bottom nav */ }}>
      <header
        className="ek-header-glass"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <Link
          to="/app"
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '10px',
            textDecoration: 'none'
          }}
        >
          <span style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '22px',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            color: 'var(--ek-mustard)'
          }}>EKKO</span>
          <span className="ek-eyebrow" style={{ paddingTop: '4px' }}>STUDIO</span>
        </Link>
        <button
          onClick={signOut}
          className="ek-icon-btn"
          style={{ width: 'auto', padding: '8px 14px', fontSize: '13px' }}
        >
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
