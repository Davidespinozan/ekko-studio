import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { X, Menu } from 'lucide-react';
import { useAdminGuard } from './hooks/useAdminGuard';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { ErrorSesion } from '@shared/components/ErrorSesion';
import { BrandLogo } from '@shared/components/BrandLogo';
import { Sidebar } from './components/Sidebar';
import { CambiarPasswordGate } from '@shared/components/CambiarPasswordGate';
import { NotificacionesBell } from '@member/components/NotificacionesBell';
import '../styles/admin.css';
import '../styles/claro.css';

const Dashboard = lazy(() => import('./pages/AdminDashboard'));
const Reportes = lazy(() => import('./pages/Reportes'));
const Miembros = lazy(() => import('./pages/Miembros'));
const MiembroDetalle = lazy(() => import('./pages/MiembroDetalle'));
const Calendario = lazy(() => import('./pages/Calendario'));
const Recursos = lazy(() => import('./pages/Recursos'));
const Tiers = lazy(() => import('./pages/Tiers'));
const Cobros = lazy(() => import('./pages/Cobros'));
const Operacion = lazy(() => import('./pages/Operacion'));
const Equipo = lazy(() => import('./pages/Equipo'));
const AjustesLanding = lazy(() => import('./pages/AjustesLanding'));
const AjustesContacto = lazy(() => import('./pages/AjustesContacto'));
const AjustesReglas = lazy(() => import('./pages/AjustesReglas'));
const AjustesMarca = lazy(() => import('./pages/AjustesMarca'));
// EKKO-149: planes STRYV (Care y Grow; solo admin; se abre desde el pie del menú, sin entrada propia).
const PlanesStryv = lazy(() => import('./pages/PlanesStryv'));

export default function AdminLayout() {
  const { isLoading, errorSesion, reintentarSesion, signOut } = useAdminGuard();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // PKG-06D (E-16): la cuenta no se pudo cargar → estado honesto, nunca "cargando".
  if (errorSesion) return <ErrorSesion tipo={errorSesion} onReintentar={() => void reintentarSesion()} onCerrarSesion={() => void signOut()} />;
  if (isLoading) return <LoadingScreen />;

  return (
    <div className="adm-shell">
      <CambiarPasswordGate />
      <div className="adm-sidebar-desktop">
        <Sidebar />
      </div>

      {drawerOpen && (
        <div className="adm-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <div className="adm-drawer" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setDrawerOpen(false)}
              aria-label="Cerrar menú"
              className="ek-icon-btn"
              style={{
                position: 'absolute',
                top: 'max(16px, env(safe-area-inset-top, 0px))',
                right: 'max(16px, env(safe-area-inset-right, 0px))',
                width: '44px',
                height: '44px',
                padding: 0,
                zIndex: 2
              }}
            >
              <X size={20} aria-hidden="true" />
            </button>
            <Sidebar onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* Lienzo claro (modelo SALA): cromo oscuro, área de trabajo clara. */}
      <div className="adm-content ek-claro">
        <header className="adm-topbar-mobile" style={{ position: 'relative', justifyContent: 'center' }}>
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Abrir menú"
            className="ek-icon-btn"
            style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', width: '44px', height: '44px', padding: 0 }}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <BrandLogo height={104} maxWidth={280} style={{ marginTop: '-18px', marginBottom: '-18px' }} />
          <div style={{ position: 'absolute', right: '16px', top: '50%', transform: 'translateY(-50%)' }}>
            <NotificacionesBell />
          </div>
        </header>
        <div className="adm-topbar-desktop-bell" style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 16px 0' }}>
          <NotificacionesBell />
        </div>

        <main className="adm-main">
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/reportes" element={<Reportes />} />
              <Route path="/miembros" element={<Miembros />} />
              <Route path="/miembros/:id" element={<MiembroDetalle />} />
              <Route path="/calendario" element={<Calendario />} />
              <Route path="/recursos" element={<Recursos />} />
              <Route path="/tiers" element={<Tiers />} />
              <Route path="/cobros" element={<Cobros />} />
              <Route path="/operacion" element={<Operacion />} />
              <Route path="/equipo" element={<Equipo />} />
              <Route path="/landing" element={<AjustesLanding />} />
              <Route path="/contacto" element={<AjustesContacto />} />
              <Route path="/reglas" element={<AjustesReglas />} />
              <Route path="/marca" element={<AjustesMarca />} />
              <Route path="/stryv" element={<PlanesStryv />} />
              {/* Legacy redirect: la página plana /admin/configuracion fue
                  reemplazada por las 4 páginas de AJUSTES (Sprint D-Admin). */}
              <Route path="/configuracion" element={<Navigate to="/admin/landing" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
