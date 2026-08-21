import { Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { LoadingScreen } from '@shared/components/LoadingScreen';
import { ToastProvider } from '@shared/providers/ToastProvider';
import ConexionBanner from '@shared/components/ConexionBanner';
import PwaInstallBanner from '@shared/components/PwaInstallBanner';
import { lazyConRecarga } from '@shared/lib/lazyConRecarga';

const PublicLayout = lazyConRecarga(() => import('@public/PublicLayout'));
const MemberLayout = lazyConRecarga(() => import('@member/MemberLayout'));
const AdminLayout = lazyConRecarga(() => import('@admin/AdminLayout'));
const ReceptionLayout = lazyConRecarga(() => import('@reception/ReceptionLayout'));

export default function App() {
  return (
    <ToastProvider>
      <ConexionBanner />
      <PwaInstallBanner />
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
