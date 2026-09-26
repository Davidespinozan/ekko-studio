import { useEffect, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';

interface Props {
  titulo: string;
  icono?: ReactNode;
  /** Nombre del miembro sobre el que se actúa. */
  sujeto?: string | null;
  confirmarLabel: string;
  guardando: boolean;
  /** Deshabilita Confirmar (p. ej. falta elegir un plan). */
  bloqueado?: boolean;
  peligro?: boolean;
  onSubmit: () => void | Promise<void>;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Cascarón de los modales de acción sobre la membresía. Resuelve en un solo
 * lugar lo que cada modal de recepción hacía (o no) por su cuenta:
 *  - el cuerpo hace SCROLL y los botones quedan fijos: en un teléfono, con el
 *    teclado abierto, "Confirmar" siempre se alcanza (antes el modal crecía más
 *    que la pantalla y el botón quedaba fuera);
 *  - Escape cierra; un clic fuera también, salvo mientras guarda.
 */
export function ModalAccion({
  titulo, icono, sujeto, confirmarLabel, guardando, bloqueado = false, peligro = false, onSubmit, onClose, children
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !guardando) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [guardando, onClose]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!guardando && !bloqueado) void onSubmit();
  }

  return (
    <div className="ek-backdrop" onClick={() => !guardando && onClose()} role="dialog" aria-modal="true" aria-label={titulo}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '18px 18px 0' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {icono}
            {titulo}
          </p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose} disabled={guardando}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '10px 18px 4px', flex: 1, minHeight: 0 }}>
          {sujeto && <p style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 10px' }}>{sujeto}</p>}
          {children}
        </div>

        <div style={{ display: 'flex', gap: '10px', padding: '14px 18px 18px', borderTop: '0.5px solid var(--ek-line)' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={guardando}>
            Cancelar
          </button>
          <button
            type="submit"
            className={peligro ? 'ek-cta ek-cta--danger' : 'ek-cta ek-cta--gold'}
            style={{ flex: 1, opacity: bloqueado ? 0.5 : 1, cursor: bloqueado ? 'not-allowed' : 'pointer' }}
            disabled={guardando || bloqueado}
          >
            {guardando ? <Spinner size={16} /> : confirmarLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
