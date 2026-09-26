import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { validarStatusStaff } from '@shared/lib/validarStatusCuenta';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { BrandLogo } from '@shared/components/BrandLogo';
import { ReceptionBottomNav } from './components/ReceptionBottomNav';
import { CambiarPasswordGate } from '@shared/components/CambiarPasswordGate';
import { NotificacionesBell } from '@member/components/NotificacionesBell';

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
  const yaCerrado = useRef(false);

  const esStaff = usuario?.rol === 'recepcionista' || usuario?.rol === 'admin';
  // "Revocar acceso" solo cambia el status: Login valida al entrar, pero no a la
  // sesión que ya estaba abierta. Aquí se saca del mostrador al staff inactivo.
  const validacion = usuario && esStaff ? validarStatusStaff(usuario) : null;

  const staffInactivo = !!validacion && !validacion.permitido;

  useEffect(() => {
    if (isLoading || !authUser || !staffInactivo) return;
    if (yaCerrado.current) return;
    yaCerrado.current = true;
    // El Navigate de abajo ya llevó al login con el motivo; esto cierra la sesión.
    void signOut();
  }, [isLoading, authUser, staffInactivo, signOut]);

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (!usuario) return <LoadingScreen />;

  if (!esStaff) {
    return <Navigate to="/app" replace />;
  }
  if (validacion && !validacion.permitido) {
    return <Navigate to="/login" state={{ mensaje: validacion.mensaje }} replace />;
  }

  const nombre = capitalizar(usuario.nombre) || usuario.email;

  return (
    <div className="rec-shell">
      <DemoBanner vista="Recepción" />
      <CambiarPasswordGate />

      <header className="ek-header-glass">
        {location.pathname === '/recepcion' ? (
          /* Home (Hoy): logo centrado (como el inicio del miembro), Salir a la derecha. */
          <div className="ek-header-inner ek-header-inner--centered">
            <BrandLogo height={104} maxWidth={280} style={{ marginTop: '-18px', marginBottom: '-18px' }} />
            <div className="ek-header-bell-abs" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <NotificacionesBell />
              <button
                onClick={signOut}
                className="ek-icon-btn"
                style={{ width: 'auto', minHeight: '44px', padding: '8px 14px', fontSize: '13px', flexShrink: 0 }}
              >
                Salir
              </button>
            </div>
          </div>
        ) : (
          <div className="ek-header-inner">
            <h1 className="ek-header-title">{tituloDeSeccion(location.pathname)}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <NotificacionesBell />
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
        )}
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
