import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { ReceptionBottomNav } from './components/ReceptionBottomNav';

/** Título de sección para el header (mismo patrón que miembro). */
function tituloDeSeccion(path: string): string {
  if (path.startsWith('/recepcion/agenda')) return 'Agenda';
  if (path.startsWith('/recepcion/miembros/')) return 'Miembro';
  if (path.startsWith('/recepcion/miembros')) return 'Miembros';
  if (path.startsWith('/recepcion/checkin')) return 'Check-in';
  return 'Hoy';
}

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
        <div className="ek-header-inner">
          <h1 className="ek-header-title">{tituloDeSeccion(location.pathname)}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <span
              style={{
                fontSize: '13px',
                color: 'var(--ek-ink-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '38vw'
              }}
            >
              {nombre}
            </span>
            <button
              onClick={signOut}
              className="ek-icon-btn"
              style={{ width: 'auto', minHeight: '44px', padding: '8px 14px', fontSize: '13px', flexShrink: 0 }}
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
