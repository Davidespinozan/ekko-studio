import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { BrandLogo } from '@shared/components/BrandLogo';
import { ReceptionBottomNav } from './components/ReceptionBottomNav';

const Hoy = lazy(() => import('./pages/Hoy'));
const Agenda = lazy(() => import('./pages/Agenda'));
const BuscarMiembro = lazy(() => import('./pages/BuscarMiembro'));
const PerfilMiembroRecepcion = lazy(() => import('./pages/PerfilMiembroRecepcion'));
const Checkin = lazy(() => import('./pages/Checkin'));

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function ReceptionLayout() {
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!usuario) return <LoadingScreen />;

  if (usuario.rol !== 'recepcionista' && usuario.rol !== 'admin') {
    return <Navigate to="/app" replace />;
  }

  const nombre = capitalizar(usuario.nombre) || usuario.email;

  return (
    <div className="rec-shell">
      <DemoBanner vista="Recepción" />

      <header className="ek-header-glass">
        <div
          className="ek-header-inner"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <div>
            <p
              className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar"
              style={{ marginBottom: '6px', fontSize: '10px' }}
            >
              RECEPCIÓN
            </p>
            <BrandLogo height={88} maxWidth={240} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)' }}>{nombre}</span>
            <button
              onClick={signOut}
              className="ek-icon-btn"
              style={{ width: 'auto', minHeight: '44px', padding: '8px 14px', fontSize: '13px' }}
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Hoy />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/miembros" element={<BuscarMiembro />} />
          <Route path="/miembros/:id" element={<PerfilMiembroRecepcion />} />
          <Route path="/checkin" element={<Checkin />} />
        </Routes>
      </Suspense>

      <ReceptionBottomNav />
    </div>
  );
}
