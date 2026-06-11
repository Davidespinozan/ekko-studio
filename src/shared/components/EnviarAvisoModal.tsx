import { useState, FormEvent } from 'react';
import { X, Send } from 'lucide-react';
import { backendPost } from '@shared/lib/backend';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';

/**
 * Envía un aviso in-app puntual a un miembro (Bloque E). Lo usan recepción y
 * admin. Llama a la Netlify Function `reception-notificar-miembro` (que inserta
 * en notificaciones + audit_log). Texto libre, sin plantillas en v1.
 */

const MAX = 500;

interface Props {
  miembroId: string;
  miembroNombre: string;
  onClose: () => void;
  onEnviado?: () => void;
}

export function EnviarAvisoModal({ miembroId, miembroNombre, onClose, onEnviado }: Props) {
  const toast = useToast();
  const [mensaje, setMensaje] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!mensaje.trim()) {
      toast.error('Escribí un mensaje.');
      return;
    }
    setSaving(true);
    try {
      await backendPost('reception-notificar-miembro', { miembro_id: miembroId, mensaje: mensaje.trim() });
      toast.success('Aviso enviado.');
      onEnviado?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo enviar el aviso.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ek-backdrop" onClick={() => !saving && onClose()} role="dialog" aria-modal="true">
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="ek-card"
        style={{ maxWidth: '440px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">ENVIAR AVISO</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: '0 0 12px' }}>
          Para <strong>{miembroNombre}</strong>. Lo verá en sus notificaciones dentro de la app.
        </p>

        <div className="ek-form-field">
          <label className="ek-label" htmlFor="aviso-msg">Mensaje</label>
          <textarea
            id="aviso-msg"
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value.slice(0, MAX))}
            placeholder="Ej. Tu pago vence mañana. Pasá por recepción si tenés dudas."
            className="ek-input"
            rows={4}
            style={{ width: '100%', resize: 'vertical' }}
          />
          <p className="ek-helper-text" style={{ textAlign: 'right' }}>{mensaje.length}/{MAX}</p>
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : <><Send size={15} aria-hidden="true" /> Enviar</>}
          </button>
        </div>
      </form>
    </div>
  );
}
