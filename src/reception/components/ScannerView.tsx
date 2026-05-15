import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { backendPost } from '@shared/lib/backend';

interface VerifyResponse {
  success: boolean;
  data?: {
    reserva: any;
    miembro: { id: string; nombre: string | null; email: string };
    recurso: { id: string; nombre: string };
  };
  error?: string;
  message?: string;
}

type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'verifying' }
  | { kind: 'success'; data: VerifyResponse['data'] }
  | { kind: 'error'; message: string };

interface Props {
  onSwitchToHoy: () => void;
}

export function ScannerView({ onSwitchToHoy }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const cooldownRef = useRef<number>(0);

  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    let active = true;

    async function start() {
      try {
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;
        setState({ kind: 'scanning' });

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            },
            audio: false
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
          });
        }

        videoEl!.srcObject = stream;
        await videoEl!.play();

        await reader.decodeFromVideoElement(videoEl!, (result) => {
          if (!active || !result) return;
          const now = Date.now();
          if (now - cooldownRef.current < 3000) return;
          cooldownRef.current = now;
          handleScan(result.getText());
        });
      } catch (e) {
        if (!active) return;
        setCameraError(e instanceof Error ? e.message : 'No se pudo acceder a la cámara');
      }
    }

    start();

    return () => {
      active = false;
      try {
        const stream = videoEl?.srcObject as MediaStream | null;
        stream?.getTracks().forEach((t) => t.stop());
      } catch { /* noop */ }
    };
  }, []);

  async function handleScan(qrPayload: string) {
    setState({ kind: 'verifying' });
    try {
      const res = await backendPost<VerifyResponse>('qr-verify', { qr_payload: qrPayload });
      if (res.success && res.data) {
        setState({ kind: 'success', data: res.data });
      } else {
        setState({ kind: 'error', message: res.message ?? 'QR no válido' });
      }
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Error verificando QR' });
    }
    setTimeout(() => setState({ kind: 'scanning' }), 4000);
  }

  return (
    <>
      <div className="rec-camera-wrap">
        {cameraError ? (
          <div className="rec-camera-error">
            <p className="ek-h3" style={{ color: 'var(--ek-cream)' }}>Sin cámara</p>
            <p style={{ color: 'rgba(245,241,232,0.7)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
              {cameraError}
            </p>
          </div>
        ) : (
          <>
            <video ref={videoRef} className="rec-video" autoPlay playsInline muted />
            <div className="rec-camera-overlay">
              <div className="rec-scan-frame" />
              <p className="rec-scan-hint">
                {state.kind === 'scanning' ? 'Apunta al QR del miembro' : ''}
              </p>
            </div>
          </>
        )}
      </div>

      <button onClick={onSwitchToHoy} className="rec-fallback-btn">
        ¿Sin QR? Ver lista de hoy →
      </button>

      {state.kind === 'verifying' && (
        <div className="rec-status rec-status--verifying">
          <p style={{ fontSize: '1.25rem', fontWeight: 600 }}>Verificando…</p>
        </div>
      )}

      {state.kind === 'success' && state.data && (
        <div className="rec-status rec-status--success">
          <p style={{ fontSize: '0.75rem', letterSpacing: '0.14em', fontWeight: 600 }}>✓ CHECK-IN OK</p>
          <p style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.5rem' }}>
            {state.data.miembro.nombre ?? state.data.miembro.email}
          </p>
          <p style={{ fontSize: '1rem', marginTop: '0.5rem', opacity: 0.8 }}>
            {state.data.recurso.nombre}
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rec-status rec-status--error">
          <p style={{ fontSize: '0.75rem', letterSpacing: '0.14em', fontWeight: 600 }}>✕ NO VÁLIDO</p>
          <p style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.5rem' }}>
            {state.message}
          </p>
        </div>
      )}
    </>
  );
}
