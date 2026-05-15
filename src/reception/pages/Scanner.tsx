import { useCallback, useState } from 'react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { backendPost } from '@shared/lib/backend';
import { ReservasHoyView } from '../components/ReservasHoyView';
import { CheckInDetail } from '../components/CheckInDetail';
import { CameraModal } from '../components/CameraModal';
import { useScannerHID } from '../hooks/useScannerHID';

interface VerifyResponse {
  success: boolean;
  data?: {
    reserva: any;
    miembro: any;
    recurso: any;
    stats?: { check_ins_hoy: number; check_ins_semana: number };
  };
  error?: string;
  message?: string;
}

type DetailState =
  | { kind: 'none' }
  | { kind: 'success'; data: VerifyResponse['data'] }
  | { kind: 'error'; message: string };

export default function Scanner() {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });
  const [cameraOpen, setCameraOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const handleQRPayload = useCallback(async (qrPayload: string) => {
    try {
      const res = await backendPost<VerifyResponse>('qr-verify', { qr_payload: qrPayload });
      if (res.success && res.data) {
        setDetail({ kind: 'success', data: res.data });
      } else {
        setDetail({ kind: 'error', message: res.message ?? 'QR no válido' });
      }
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setDetail({ kind: 'error', message: e instanceof Error ? e.message : 'Error verificando QR' });
    }
  }, []);

  // Listener de scanner HID. Se pausa cuando hay modales abiertos.
  useScannerHID(handleQRPayload, detail.kind === 'none' && !cameraOpen);

  const closeDetail = () => setDetail({ kind: 'none' });
  const handleManualCheckIn = (data: VerifyResponse['data']) => {
    setDetail({ kind: 'success', data });
    setRefreshTick((t) => t + 1);
  };

  return (
    <div className="rec-shell">
      <header className="rec-topbar">
        <div>
          <p className="ek-eyebrow" style={{ color: 'var(--ek-cream)' }}>RECEPCIÓN</p>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--ek-cream)', marginTop: '2px' }}>
            {tenant.nombre}
          </h1>
        </div>
        <div className="rec-topbar-right">
          <button onClick={() => setCameraOpen(true)} className="rec-link-btn">
            📷 Cámara
          </button>
          <span style={{ fontSize: '0.8125rem', color: 'rgba(245,241,232,0.6)' }}>
            {usuario?.nombre ?? usuario?.email}
          </span>
          <button onClick={signOut} className="rec-link-btn">Salir</button>
        </div>
      </header>

      <div className="rec-main">
        <ReservasHoyView
          key={refreshTick}
          onManualCheckInSuccess={handleManualCheckIn}
        />
      </div>

      {cameraOpen && (
        <CameraModal
          onClose={() => setCameraOpen(false)}
          onScan={(payload) => {
            setCameraOpen(false);
            handleQRPayload(payload);
          }}
        />
      )}

      {detail.kind !== 'none' && (
        <div className="rec-detail-backdrop">
          <CheckInDetail
            kind={detail.kind}
            miembro={detail.kind === 'success' ? detail.data?.miembro : undefined}
            recurso={detail.kind === 'success' ? detail.data?.recurso : undefined}
            reserva={detail.kind === 'success' ? detail.data?.reserva : undefined}
            stats={detail.kind === 'success' ? detail.data?.stats : undefined}
            errorMessage={detail.kind === 'error' ? detail.message : undefined}
            onClose={closeDetail}
          />
        </div>
      )}
    </div>
  );
}
