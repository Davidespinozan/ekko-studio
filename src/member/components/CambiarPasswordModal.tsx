import { X, KeyRound } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { CambiarPasswordForm } from '@shared/components/CambiarPasswordForm';

interface Props {
  onClose: () => void;
}

/** El miembro cambia su contraseña desde su perfil (antes no existía forma). */
export function CambiarPasswordModal({ onClose }: Props) {
  const toast = useToast();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cpm-title"
      className="ek-backdrop"
      onClick={onClose}
    >
      <div className="ek-card" style={{ width: '100%', maxWidth: '420px', padding: '24px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <span className="ek-empty-icon" style={{ width: 40, height: 40, margin: 0, flexShrink: 0 }}>
            <KeyRound size={18} aria-hidden="true" />
          </span>
          <h2 id="cpm-title" style={{ fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', margin: 0, flex: 1 }}>
            Cambiar contraseña
          </h2>
          <button type="button" onClick={onClose} className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <CambiarPasswordForm
          autoFocus
          onSuccess={() => {
            toast.success('Contraseña actualizada');
            onClose();
          }}
        />
      </div>
    </div>
  );
}
