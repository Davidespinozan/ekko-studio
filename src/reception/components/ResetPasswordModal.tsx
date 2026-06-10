import { useState } from 'react';
import { X, KeyRound, AlertTriangle } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { CopyButton } from '@shared/components/CopyButton';
import { resetearPasswordMiembro } from '../lib/accionesMiembro';

interface Props {
  miembroId: string;
  miembroNombre: string;
  onClose: () => void;
}

/**
 * Resetea la contraseña del miembro (olvidó el acceso) y muestra la nueva
 * para entregársela en mostrador. La contraseña se ve una sola vez.
 */
export function ResetPasswordModal({ miembroId, miembroNombre, onClose }: Props) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [cred, setCred] = useState<{ email: string; password: string } | null>(null);

  async function confirmar() {
    setLoading(true);
    try {
      const res = await resetearPasswordMiembro(miembroId);
      setCred({ email: res.email, password: res.password });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo resetear la contraseña.');
      setLoading(false);
    }
  }

  const textoCompartir = cred
    ? `Acceso a EKKO Studio:\nEmail: ${cred.email}\nContraseña temporal: ${cred.password}\n${window.location.origin}/login`
    : '';

  return (
    <div className="ek-backdrop" onClick={() => !loading && onClose()} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '420px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">RESETEAR CONTRASEÑA</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {!cred ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '14px 0' }}>
              <span className="ek-empty-icon"><KeyRound size={24} aria-hidden="true" /></span>
            </div>
            <p className="ek-body" style={{ textAlign: 'center', marginBottom: '6px' }}>
              Generar una contraseña temporal para <strong>{miembroNombre}</strong>.
            </p>
            <p className="ek-body-faint" style={{ textAlign: 'center', marginBottom: '20px' }}>
              La contraseña anterior dejará de funcionar. Se mostrará una sola vez.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={loading}>
                Cancelar
              </button>
              <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={confirmar} disabled={loading}>
                {loading ? <Spinner size={16} /> : 'Generar'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{
              background: 'var(--ek-bg-elevated)', border: '0.5px solid var(--ek-mustard-dim)',
              borderRadius: 'var(--ek-r-sm)', padding: '14px 16px', margin: '12px 0'
            }}>
              <CredLine label="Email" valor={cred.email} />
              <CredLine label="Contraseña" valor={cred.password} mono />
            </div>
            <p className="ek-body-faint" style={{ display: 'flex', gap: '6px', alignItems: 'flex-start', marginBottom: '16px' }}>
              <AlertTriangle size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: '2px', color: 'var(--ek-warning)' }} />
              Entregala ahora — no vas a poder verla de nuevo.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <CopyButton text={textoCompartir} label="Copiar" copiedLabel="Copiado" full />
              <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={onClose}>
                Listo
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CredLine({ label, valor, mono }: { label: string; valor: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0' }}>
      <span style={{ fontSize: '12px', color: 'var(--ek-ink-faint)' }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--ek-ink)', fontFamily: mono ? 'var(--ek-font-mono)' : undefined, fontWeight: 600 }}>
        {valor}
      </span>
    </div>
  );
}
