import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { validarStatusCuenta } from '@shared/lib/validarStatusCuenta';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { BrandLogo } from '@shared/components/BrandLogo';
import NotificacionesBanner from './components/NotificacionesBanner';
import { BottomNav } from './components/BottomNav';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const PagarMembresia = lazy(() => import('./pages/PagarMembresia'));
const Reservar = lazy(() => import('./pages/Reservar'));
const Perfil = lazy(() => import('./pages/Perfil'));
const MiQR = lazy(() => import('./pages/MiQR'));
const Estudios = lazy(() => import('./pages/Estudios'));
const EstudioDetalle = lazy(() => import('./pages/EstudioDetalle'));

export default function MemberLayout() {
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const location = useLocation();
  const yaCerrado = useRef(false);

  // Defensa profunda: el chequeo principal de status vive en Login (S1).
  // Acá cubrimos la sesión vieja cuyo status cambió mientras estaba dentro.
  const validacion = usuario ? validarStatusCuenta(usuario) : null;

  // `pendiente_pago` NO se echa: puede pagar su membresía self-serve (abajo).
  const pendientePago = usuario?.status === 'pendiente_pago';

  useEffect(() => {
    if (isLoading) return;
    if (!authUser || !usuario) return;
    if (validarStatusCuenta(usuario).permitido) return;
    if (pendientePago) return; // se queda para pagar
    if (yaCerrado.current) return;
    yaCerrado.current = true;
    // signOut limpia la sesión; el Navigate de abajo redirige a /login
    // con el mensaje claro (no flash, no deslogueo silencioso).
    void signOut();
  }, [authUser, usuario, isLoading, signOut, pendientePago]);

  if (isLoading) return <LoadingScreen />;
  if (!authUser) return <Navigate to="/login" state={{ from: location }} replace />;
  if (pendientePago) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <PagarMembresia />
      </Suspense>
    );
  }
  if (usuario && validacion && !validacion.permitido) {
    return <Navigate to="/login" state={{ mensaje: validacion.mensaje }} replace />;
  }

  return (
    <div className="ek-page" style={{ paddingBottom: '88px' /* espacio para bottom nav */ }}>
      <DemoBanner vista="Miembro" />
      <NotificacionesBanner />
      <header className="ek-header-glass">
        <div className="ek-header-inner">
          <Link
            to="/app"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              textDecoration: 'none'
            }}
          >
            <BrandLogo height={88} maxWidth={280} />
          </Link>
        </div>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/reservar" element={<Reservar />} />
          <Route path="/estudios" element={<Estudios />} />
          <Route path="/estudios/:slug" element={<EstudioDetalle />} />
          {/* /historial removida — redirect a /perfil para no romper bookmarks viejos */}
          <Route path="/historial" element={<Navigate to="/app/perfil" replace />} />
          <Route path="/perfil" element={<Perfil />} />
          <Route path="/qr/:reservaId" element={<MiQR />} />
        </Routes>
      </Suspense>

      <BottomNav />
    </div>
  );
}
