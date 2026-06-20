import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { ToastProvider } from '@shared/providers/ToastProvider';
import ConexionBanner from '@shared/components/ConexionBanner';

const PublicLayout = lazy(() => import('@public/PublicLayout'));
const MemberLayout = lazy(() => import('@member/MemberLayout'));
const AdminLayout = lazy(() => import('@admin/AdminLayout'));
const ReceptionLayout = lazy(() => import('@reception/ReceptionLayout'));

export default function App() {
  return (
    <ToastProvider>
      <ConexionBanner />
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/app/*" element={<MemberLayout />} />
          <Route path="/admin/*" element={<AdminLayout />} />
          <Route path="/recepcion/*" element={<ReceptionLayout />} />
          <Route path="/*" element={<PublicLayout />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}
