import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Camera, Upload, RefreshCw, Check, SwitchCamera } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { actualizarMiembro, imagenABase64Jpeg } from '../lib/accionesMiembro';

interface Props {
  miembroId: string;
  miembroNombre: string;
  onClose: () => void;
  onActualizada: (avatarUrl: string | null) => void;
}

type Captura = { base64: string; contentType: string; preview: string };

/**
 * Toma o sube la foto (avatar) del miembro desde recepción. Cámara con
 * getUserMedia (con opción de voltear) o archivo; la imagen se reduce a JPEG
 * y se envía a reception-update-member (service_role sube a storage).
 */
export function FotoMiembroModal({ miembroId, miembroNombre, onClose, onActualizada }: Props) {
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [camError, setCamError] = useState(false);
  const [captura, setCaptura] = useState<Captura | null>(null);
  const [saving, setSaving] = useState(false);

  const detener = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const iniciarCamara = useCallback(async (modo: 'user' | 'environment') => {
    detener();
    setCamError(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: modo },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setCamError(true);
    }
  }, [detener]);

  useEffect(() => {
    if (!captura) void iniciarCamara(facing);
    return detener;
  }, [facing, captura, iniciarCamara, detener]);

  async function capturarDeCamara() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const { base64, contentType } = await imagenABase64Jpeg(v);
    setCaptura({ base64, contentType, preview: `data:${contentType};base64,${base64}` });
    detener();
  }

  async function onArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Elegí un archivo de imagen.');
      return;
    }
    const { base64, contentType } = await imagenABase64Jpeg(file);
    setCaptura({ base64, contentType, preview: `data:${contentType};base64,${base64}` });
    detener();
  }

  async function guardar() {
    if (!captura) return;
    setSaving(true);
    try {
      const res = await actualizarMiembro(miembroId, {
        avatar: { base64: captura.base64, contentType: captura.contentType }
      });
      toast.success('Foto actualizada.');
      onActualizada(res.avatar_url ?? null);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la foto.');
      setSaving(false);
    }
  }

  return (
    <div className="ek-backdrop" onClick={() => !saving && onClose()} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '420px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">FOTO DE {miembroNombre.toUpperCase()}</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Marco de cámara / preview, cuadrado y edge-to-edge dentro del card */}
        <div style={{
          position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 'var(--ek-r-md)',
          overflow: 'hidden', background: '#000', margin: '12px 0 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          {captura ? (
            <img src={captura.preview} alt="Vista previa" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : camError ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--ek-ink-muted)' }}>
              <Camera size={28} aria-hidden="true" style={{ marginBottom: '8px', opacity: 0.6 }} />
              <p style={{ fontSize: '13px', margin: 0 }}>No se pudo abrir la cámara. Subí un archivo.</p>
            </div>
          ) : (
            <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}

          {!captura && !camError && (
            <button
              type="button"
              onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
              className="ek-media-ctrl"
              aria-label="Voltear cámara"
              style={{ position: 'absolute', top: '10px', right: '10px', width: '40px', height: '40px' }}
            >
              <SwitchCamera size={18} aria-hidden="true" />
            </button>
          )}
        </div>

        <input ref={fileRef} type="file" accept="image/*" onChange={onArchivo} style={{ display: 'none' }} />

        {captura ? (
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={() => setCaptura(null)} disabled={saving}>
              <RefreshCw size={16} aria-hidden="true" /> Repetir
            </button>
            <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={guardar} disabled={saving}>
              {saving ? <Spinner size={16} /> : <><Check size={16} aria-hidden="true" /> Usar foto</>}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>
              <Upload size={16} aria-hidden="true" /> Subir archivo
            </button>
            {!camError && (
              <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={capturarDeCamara}>
                <Camera size={16} aria-hidden="true" /> Capturar
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
