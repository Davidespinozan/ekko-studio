import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, ScanLine } from 'lucide-react';
import { backendPost } from '@shared/lib/backend';
import { CheckInDetail } from '../components/CheckInDetail';
import { CameraModal } from '../components/CameraModal';
import { useScannerHID } from '../hooks/useScannerHID';

/**
 * "Check-in" — scanner QR dedicado (Bloque B/C). Es lo que antes vivía en
 * Scanner.tsx, SIN el panel del día embebido (eso se movió a "Hoy"). Pantalla
 * limpia, foco en el escaneo. El check-in manual vive en "Hoy".
 */

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

export default function Checkin() {
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });
  const [cameraOpen, setCameraOpen] = useState(false);

  const handleQRPayload = useCallback(async (qrPayload: string) => {
    try {
      const res = await backendPost<VerifyResponse>('qr-verify', { qr_payload: qrPayload });
      if (res.success && res.data) {
        setDetail({ kind: 'success', data: res.data });
      } else {
        setDetail({ kind: 'error', message: res.message ?? 'QR no válido' });
      }
    } catch (e) {
      setDetail({ kind: 'error', message: e instanceof Error ? e.message : 'Error verificando QR' });
    }
  }, []);

  // Listener de scanner HID. Se pausa cuando hay modales abiertos.
  useScannerHID(handleQRPayload, detail.kind === 'none' && !cameraOpen);

  const closeDetail = () => setDetail({ kind: 'none' });

  return (
    <>
      <div
        className="rec-main"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          minHeight: '60vh',
          gap: '20px'
        }}
      >
        <div
          style={{
            width: '88px',
            height: '88px',
            borderRadius: '50%',
            background: 'var(--ek-mustard-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <ScanLine size={40} style={{ color: 'var(--ek-mustard)' }} aria-hidden="true" />
        </div>

        <div>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
            CHECK-IN
          </p>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '22px',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              margin: 0,
              color: 'var(--ek-ink)'
            }}
          >
            Escaneá el QR del cliente
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: '8px auto 0', maxWidth: '320px' }}>
            Usá el lector o abrí la cámara. El check-in se confirma al leer un QR válido.
          </p>
        </div>

        <button
          onClick={() => setCameraOpen(true)}
          className="ek-cta ek-cta--gold"
          style={{ minHeight: '52px', padding: '0 28px' }}
        >
          <Camera size={18} aria-hidden="true" /> Abrir cámara
        </button>

        <Link to="/recepcion" className="adm-link" style={{ fontSize: '13px' }}>
          No tengo el QR — buscar en "Hoy"
        </Link>
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
    </>
  );
}
