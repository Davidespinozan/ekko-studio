import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { validarStatusCuenta } from '@shared/lib/validarStatusCuenta';
import { MENSAJE_EN_PAUSA, suspendidoPorPausa } from '@shared/lib/pausaMembresia';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';
import { BrandLogo } from '@shared/components/BrandLogo';
import { NotificacionesBell } from './components/NotificacionesBell';
import { BottomNav } from './components/BottomNav';
import { CambiarPasswordGate } from '@shared/components/CambiarPasswordGate';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const PagarMembresia = lazy(() => import('./pages/PagarMembresia'));
const Reservar = lazy(() => import('./pages/Reservar'));
const MisReservas = lazy(() => import('./pages/MisReservas'));
const Perfil = lazy(() => import('./pages/Perfil'));
const MiQR = lazy(() => import('./pages/MiQR'));
const MiQRProxima = lazy(() => import('./pages/MiQRProxima'));
const MiMaterial = lazy(() => import('./pages/MiMaterial'));
const Estudios = lazy(() => import('./pages/Estudios'));
const EstudioDetalle = lazy(() => import('./pages/EstudioDetalle'));

/**
 * Título de la sección para el header. En Inicio devuelve null → se muestra el
 * logo; en el resto el título ocupa ese espacio (el logo no aporta ahí).
 */
function tituloDeSeccion(path: string): string | null {
  if (path === '/app' || path === '/app/') return null;
  if (path.startsWith('/app/estudios')) return 'Estudios';
  if (path.startsWith('/app/reservar')) return 'Reservar';
  if (path.startsWith('/app/reservas')) return 'Mis reservas';
  if (path.startsWith('/app/perfil')) return 'Perfil';
  if (path.startsWith('/app/material')) return 'Mi material';
  if (path.startsWith('/app/qr')) return 'Mi QR';
  return null;
}

export default function MemberLayout() {
  const { authUser, usuario, isLoading, signOut } = useAuth();
  const location = useLocation();
  const yaCerrado = useRef(false);

  // Defensa profunda: el chequeo principal de status vive en Login (S1).
  // Aquí cubrimos la sesión vieja cuyo status cambió mientras estaba dentro.
  const validacion = usuario ? validarStatusCuenta(usuario) : null;

  // `pendiente_pago` NO se echa: puede pagar su membresía self-serve (abajo).
  const pendientePago = usuario?.status === 'pendiente_pago';
  // Mensaje con el que se despide a la sesión que ya no puede seguir. Se
  // resuelve ANTES de cerrar sesión: una pausa (viaje, lesión) deja la cuenta
  // en `suspendido` igual que una sanción, y "Tu cuenta está suspendida" a
  // quien pidió la pausa le suena a castigo (A8). Login ya lo distinguía; aquí
  // faltaba para la sesión que seguía abierta cuando cambió el status.
  const [mensajeSalida, setMensajeSalida] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!authUser || !usuario) return;
    const v = validarStatusCuenta(usuario);
    if (v.permitido) return;
    if (pendientePago) return; // se queda para pagar
    if (yaCerrado.current) return;
    yaCerrado.current = true;
    void (async () => {
      // Con la sesión viva todavía puede leer sus membresías (RLS); después no.
      const enPausa = usuario.status === 'suspendido' && (await suspendidoPorPausa(usuario.id));
      setMensajeSalida(enPausa ? MENSAJE_EN_PAUSA : v.mensaje ?? 'Tu cuenta no está activa.');
      // signOut limpia la sesión; el Navigate de abajo redirige a /login
      // con el mensaje claro (no flash, no deslogueo silencioso).
      await signOut();
    })();
  }, [authUser, usuario, isLoading, signOut, pendientePago]);

  // Va ANTES del chequeo de authUser: cuando signOut termina, authUser ya es
  // null y el redirect genérico se comería el mensaje.
  if (mensajeSalida) return <Navigate to="/login" state={{ mensaje: mensajeSalida }} replace />;
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
    // El efecto de arriba está resolviendo el mensaje (pausa vs. sanción).
    return <LoadingScreen />;
  }

  return (
    <div className="ek-page" style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' /* espacio para la píldora flotante */ }}>
      <DemoBanner vista="Miembro" />
      <CambiarPasswordGate />
      <header className="ek-header-glass">
        {tituloDeSeccion(location.pathname) ? (
          <div className="ek-header-inner">
            <h1 className="ek-header-title">{tituloDeSeccion(location.pathname)}</h1>
            <NotificacionesBell />
          </div>
        ) : (
          /* Inicio: logo centrado, campana anclada a la derecha */
          <div className="ek-header-inner ek-header-inner--centered">
            {/* Margen negativo: el logo es grande pero el PNG trae aire arriba/abajo;
                así el header no queda con una franja gris de más. */}
            <Link to="/app" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', marginTop: '-20px', marginBottom: '-20px' }}>
              <BrandLogo height={104} maxWidth={360} />
            </Link>
            <div className="ek-header-bell-abs">
              <NotificacionesBell />
            </div>
          </div>
        )}
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/reservar" element={<Reservar />} />
          <Route path="/estudios" element={<Estudios />} />
          <Route path="/estudios/:slug" element={<EstudioDetalle />} />
          <Route path="/reservas" element={<MisReservas />} />
          {/* bookmarks viejos → nueva página de reservas */}
          <Route path="/historial" element={<Navigate to="/app/reservas" replace />} />
          <Route path="/perfil" element={<Perfil />} />
          <Route path="/material" element={<MiMaterial />} />
          <Route path="/qr" element={<MiQRProxima />} />
          <Route path="/qr/:reservaId" element={<MiQR />} />
        </Routes>
      </Suspense>

      <BottomNav />
    </div>
  );
}
