import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { LoadingScreen } from '@shared/components/LoadingScreen';

const Dashboard = lazy(() => import('./pages/Dashboard'));

export default function MemberLayout() {
  const tenant = useTenant();
  const { authUser, isLoading, signOut } = useAuth();
  const location = useLocation();

  // Mientras hidrata, mostrar loading
  if (isLoading) {
    return <LoadingScreen />;
  }

  // No autenticado → redirigir a login con redirect param
  if (!authUser) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="ek-page">
      <header
        style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--ek-line)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <Link to="/app" style={{ fontWeight: 700, fontSize: '1.125rem' }}>
          {tenant.nombre}
        </Link>
        <button
          onClick={signOut}
          style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}
        >
          Salir
        </button>
      </header>

      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </Suspense>
    </div>
  );
}
