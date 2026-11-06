import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useRoleRedirect } from '@shared/hooks/useRoleRedirect';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { DemoBanner } from '@shared/components/DemoBanner';

const Landing = lazy(() => import('./pages/Landing'));
const Login = lazy(() => import('./pages/Login'));
const Signup = lazy(() => import('./pages/Signup'));
const Terminos = lazy(() => import('./pages/Terminos'));
const Privacidad = lazy(() => import('./pages/Privacidad'));
const RecuperarContrasena = lazy(() => import('./pages/RecuperarContrasena'));
const NuevaContrasena = lazy(() => import('./pages/NuevaContrasena'));
const ConfirmarCorreo = lazy(() => import('./pages/ConfirmarCorreo'));

export default function PublicLayout() {
  const { authUser, signOut } = useAuth();
  const location = useLocation();
  // Fase 2 premium: login, recuperar y nueva contraseña traen su propio marco (AccesoLayout).
  const enAcceso = ['/login', '/recuperar', '/nueva-contrasena'].includes(location.pathname);
  // Fase 1 premium: la landing trae su propia navegación flotante (LandingNav).
  const enLanding = location.pathname === '/';
  useRoleRedirect(['/', '/login', '/signup']);

  return (
    <div className="ek-page">
      <DemoBanner vista="Landing" />
      {!enLanding && !enAcceso && (
        <header
          style={{
            padding: 'calc(1rem + env(safe-area-inset-top, 0px)) 1.25rem 1rem',
            borderBottom: '1px solid var(--ek-line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <Link to="/" style={{ display: 'inline-flex', alignItems: 'center' }}>
            <img
              src="https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png"
              alt="EKKO Studio"
              style={{ height: '86px', width: 'auto', display: 'block' }}
            />
          </Link>
          <nav style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            {authUser ? (
              <>
                <Link to="/app" className="ek-cta ek-cta--gold" style={{ padding: '0.625rem 1.25rem', minHeight: '44px', display: 'inline-flex', alignItems: 'center' }}>
                  Mi cuenta
                </Link>
                <button
                  onClick={signOut}
                  style={{
                    fontSize: '0.875rem',
                    color: 'var(--ek-ink-muted)',
                    minHeight: '44px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0 8px'
                  }}
                >
                  Salir
                </button>
              </>
            ) : (
              <Link
                to="/login"
                className="ek-cta ek-cta--gold"
                style={{ padding: '0.625rem 1.25rem', minHeight: '44px', display: 'inline-flex', alignItems: 'center' }}
              >
                Iniciar sesión
              </Link>
            )}
          </nav>
        </header>
      )}

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/recuperar" element={<RecuperarContrasena />} />
          <Route path="/nueva-contrasena" element={<NuevaContrasena />} />
          <Route path="/confirmar-correo" element={<ConfirmarCorreo />} />
          <Route path="/terminos" element={<Terminos />} />
          <Route path="/privacidad" element={<Privacidad />} />
        </Routes>
      </Suspense>
    </div>
  );
}
