import { useCallback, useState } from 'react';
import { Camera } from 'lucide-react';
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
    <>
      <div className="rec-main">
        <ReservasHoyView
          key={refreshTick}
          onManualCheckInSuccess={handleManualCheckIn}
          pausarPolling={detail.kind !== 'none' || cameraOpen}
        />
      </div>

      <button
        onClick={() => setCameraOpen(true)}
        aria-label="Abrir cámara para escanear QR"
        style={{
          position: 'fixed',
          bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
          right: 'calc(24px + env(safe-area-inset-right, 0px))',
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          background: 'var(--ek-mustard)',
          color: 'var(--ek-bg)',
          border: 'none',
          boxShadow: 'var(--ek-shadow-cta)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          transition: 'transform 0.2s ease, box-shadow 0.2s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseDown={(e) => {
          e.currentTarget.style.transform = 'scale(0.96)';
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
      >
        <Camera size={28} aria-hidden="true" />
      </button>

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
    </>
  );
}
