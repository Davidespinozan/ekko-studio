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

export default function PublicLayout() {
  const { authUser, signOut } = useAuth();
  const location = useLocation();
  const enLogin = location.pathname === '/login';
  useRoleRedirect(['/', '/login', '/signup']);

  return (
    <div className="ek-page">
      <DemoBanner vista="Landing" />
      <header
        style={{
          padding: 'calc(1rem + env(safe-area-inset-top, 0px)) 1.25rem 1rem',
          borderBottom: '1px solid var(--ek-line)',
          display: 'flex',
          // En login el nav va vacío → el logo se centra y crece (tamaño miembro).
          justifyContent: enLogin ? 'center' : 'space-between',
          alignItems: 'center'
        }}
      >
        <Link to="/" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <img
            src="https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/EKKO_STUDIO_logo_transparente.png"
            alt="EKKO Studio"
            style={{ height: enLogin ? '104px' : '86px', width: 'auto', display: 'block' }}
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
          ) : !enLogin ? (
            <Link
              to="/login"
              className="ek-cta ek-cta--gold"
              style={{ padding: '0.625rem 1.25rem', minHeight: '44px', display: 'inline-flex', alignItems: 'center' }}
            >
              Iniciar sesión
            </Link>
          ) : null}
        </nav>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/terminos" element={<Terminos />} />
          <Route path="/privacidad" element={<Privacidad />} />
        </Routes>
      </Suspense>
    </div>
  );
}
