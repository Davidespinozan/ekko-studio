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
const Estudios = lazy(() => import('./pages/Estudios'));
const EstudioDetalle = lazy(() => import('./pages/EstudioDetalle'));

export default function MemberLayout() {
  const { authUser, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;

  return (
    <div className="ek-page" style={{ paddingBottom: '88px' /* espacio para bottom nav */ }}>
      <header className="ek-header-glass">
        <div className="ek-header-inner">
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
        </div>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/reservar" element={<Reservar />} />
          <Route path="/estudios" element={<Estudios />} />
          <Route path="/estudios/:slug" element={<EstudioDetalle />} />
          <Route path="/historial" element={<Historial />} />
          <Route path="/perfil" element={<Perfil />} />
          <Route path="/qr/:reservaId" element={<MiQR />} />
        </Routes>
      </Suspense>

      <BottomNav />
    </div>
  );
}
