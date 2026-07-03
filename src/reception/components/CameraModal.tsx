import { useEffect, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { X, RefreshCw } from 'lucide-react';

interface Props {
  onClose: () => void;
  onScan: (payload: string) => void;
}

// BarcodeDetector nativo (Chrome/Android/Safari 17+) no está en los tipos de TS.
type AnyWin = any;

export function CameraModal({ onClose, onScan }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const rafRef = useRef<number | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const cooldownRef = useRef(0);

  const reintentar = () => {
    setCameraError(null);
    setRetryTick((t) => t + 1);
  };

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    let active = true;

    async function start() {
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }

        videoEl!.srcObject = stream;
        await videoEl!.play();

        // Enfoque continuo (best-effort): permite leer sin esperar al autofoco.
        try {
          const track = stream.getVideoTracks()[0];
          const caps = (track.getCapabilities?.() ?? {}) as AnyWin;
          if (caps.focusMode?.includes?.('continuous')) {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as AnyWin);
          }
        } catch { /* noop */ }

        const hit = (text: string) => {
          if (!active) return;
          const now = Date.now();
          if (now - cooldownRef.current < 1500) return;
          cooldownRef.current = now;
          onScan(text);
        };

        // 1) BarcodeDetector NATIVO: mucho más rápido y robusto (agarra el QR
        //    aunque el cuadro no esté perfectamente enfocado).
        const BD = (window as AnyWin).BarcodeDetector as AnyWin;
        let usarNativo = false;
        if (BD) {
          try {
            const soportados = (await BD.getSupportedFormats?.()) as string[] | undefined;
            usarNativo = !soportados || soportados.includes('qr_code');
          } catch { usarNativo = false; }
        }

        if (usarNativo) {
          const detector = new BD({ formats: ['qr_code'] });
          const loop = async () => {
            if (!active) return;
            try {
              const codes = await detector.detect(videoEl!);
              if (codes && codes.length && codes[0].rawValue) hit(codes[0].rawValue);
            } catch { /* frame aún no listo */ }
            if (active) rafRef.current = requestAnimationFrame(loop);
          };
          rafRef.current = requestAnimationFrame(loop);
          return;
        }

        // 2) Fallback: ZXing SOLO QR (más rápido que multi-formato).
        const reader = new BrowserQRCodeReader();
        controlsRef.current = await reader.decodeFromVideoElement(videoEl!, (result) => {
          if (result) hit(result.getText());
        });
      } catch (e) {
        if (!active) return;
        setCameraError(e instanceof Error ? e.message : 'No se pudo acceder a la cámara');
      }
    }

    start();

    return () => {
      active = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { controlsRef.current?.stop(); } catch { /* noop */ }
      try {
        const stream = videoEl?.srcObject as MediaStream | null;
        stream?.getTracks().forEach((t) => t.stop());
      } catch { /* noop */ }
    };
  }, [onScan, retryTick]);

  return (
    <div className="rec-camera-modal" onClick={onClose}>
      <div className="rec-camera-modal-inner" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="rec-camera-close ek-media-ctrl"
          aria-label="Cerrar cámara"
        >
          <X size={20} aria-hidden="true" />
        </button>
        <div className="rec-camera-wrap">
          {cameraError ? (
            <div className="rec-camera-error">
              <p className="ek-h3" style={{ color: 'var(--ek-ink)' }}>
                No pudimos acceder a la cámara
              </p>
              <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
                Verifica que diste permiso de cámara en los ajustes de tu navegador
                y vuelve a intentar.
              </p>
              <p style={{ color: 'var(--ek-ink-faint)', fontSize: '0.75rem', marginTop: '0.5rem' }}>
                {cameraError}
              </p>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  marginTop: '20px'
                }}
              >
                <button
                  type="button"
                  onClick={reintentar}
                  className="ek-cta ek-cta--gold"
                  style={{ minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Reintentar
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="ek-cta ek-cta--secondary"
                  style={{ minHeight: '44px' }}
                >
                  Usar check-in manual
                </button>
              </div>
            </div>
          ) : (
            <>
              <video ref={videoRef} className="rec-video" autoPlay playsInline muted />
              <div className="rec-camera-overlay">
                <div className="rec-scan-frame" />
                <p className="rec-scan-hint">Apunta al QR</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
