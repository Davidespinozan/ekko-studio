import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
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

export default function Scanner() {
  const { usuario, signOut } = useAuth();
  const tenant = useTenant();
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const cooldownRef = useRef<number>(0); // timestamp del último escaneo para evitar duplicados

  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Inicializar scanner
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    let active = true;

    async function start() {
      try {
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;
        setState({ kind: 'scanning' });

        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const backCam = devices.find((d) => /back|rear|environment/i.test(d.label));
        const deviceId = backCam?.deviceId ?? devices[0]?.deviceId;

        await reader.decodeFromVideoDevice(deviceId, videoEl!, (result) => {
          if (!active || !result) return;
          const now = Date.now();
          if (now - cooldownRef.current < 3000) return; // ignora rescaneos dentro de 3s
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
        // BrowserMultiFormatReader auto-cleanup
        const stream = videoEl.srcObject as MediaStream | null;
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

    // Auto-reset después de 4 segundos
    setTimeout(() => setState({ kind: 'scanning' }), 4000);
  }

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
          <span style={{ fontSize: '0.8125rem', color: 'rgba(245,241,232,0.6)' }}>
            {usuario?.nombre ?? usuario?.email}
          </span>
          <button onClick={signOut} className="rec-link-btn">Salir</button>
        </div>
      </header>

      <div className="rec-main">
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
      </div>
    </div>
  );
}
