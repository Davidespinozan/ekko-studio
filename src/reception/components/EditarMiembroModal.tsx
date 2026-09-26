import { useState, FormEvent } from 'react';
import { X } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { actualizarMiembro } from '../lib/accionesMiembro';

export interface MiembroEditable {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
}

interface Props {
  miembro: MiembroEditable;
  onClose: () => void;
  onGuardado: () => void;
}

/**
 * Edición de los DATOS DE CONTACTO del miembro desde recepción (nombre,
 * teléfono, email). El email también cambia la cuenta de acceso (auth).
 *
 * Ya NO trae estado de cuenta ni plan (R5 de la paridad SALA): poner
 * `status='activo'` o un plan a mano sin cobrar era la puerta trasera que la
 * auditoría #1 cerró en admin (P0-7) y aquí seguía abierta. Cada una de esas
 * acciones vive ahora en su tarjeta con su regla y su rastro: el plan se
 * activa con dinero (`MembresiaCard`) y el estado de la cuenta se cambia con
 * motivo (`EstadoCuentaCard`).
 */
export function EditarMiembroModal({ miembro, onClose, onGuardado }: Props) {
  const toast = useToast();
  const [nombre, setNombre] = useState(miembro.nombre ?? '');
  const [email, setEmail] = useState(miembro.email);
  const [telefono, setTelefono] = useState(miembro.telefono ?? '');
  const [saving, setSaving] = useState(false);

  const emailCambia = email.trim().toLowerCase() !== miembro.email.toLowerCase();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await actualizarMiembro(miembro.id, { nombre, telefono, email });
      if (res.sin_cambios) {
        toast.info('No había cambios para guardar.');
      } else {
        toast.success(`Datos actualizados (${res.cambios?.join(', ')}).`);
      }
      onGuardado();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ek-backdrop" role="dialog" aria-modal="true">
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '92vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">EDITAR DATOS</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="ek-stack-md">
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="em-nombre">Nombre</label>
            <input id="em-nombre" className="ek-input" value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="off" />
          </div>
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="em-tel">Teléfono</label>
            <input id="em-tel" className="ek-input" value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel" autoComplete="off" />
          </div>
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="em-email">Email (acceso)</label>
            <input id="em-email" type="email" className="ek-input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            {emailCambia && (
              <p className="ek-helper-text" style={{ color: 'var(--ek-warning)' }}>
                Cambiar el email también cambia el correo con el que el cliente inicia sesión.
              </p>
            )}
          </div>
          <p className="ek-body-faint" style={{ margin: 0 }}>
            El plan y el estado de la cuenta se cambian desde sus propias tarjetas en la ficha.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}
