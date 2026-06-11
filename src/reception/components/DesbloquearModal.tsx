import { useState, FormEvent } from 'react';
import { X, Unlock } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { actualizarMiembro } from '../lib/accionesMiembro';
import { MotivoField } from './MotivoField';

interface Props {
  miembroId: string;
  miembroNombre: string;
  onClose: () => void;
  onDesbloqueado: () => void;
}

const MOTIVOS_DESBLOQUEO = [
  'Cliente justificó el no-show',
  'Error operativo (no fue no-show real)',
  'Decisión del dueño'
];

/**
 * Levantar el bloqueo por inasistencia de un miembro (Bloque A — gobernanza).
 * Exige motivo: queda en audit_log. NO resetea no_shows_count (B4) — el
 * historial de inasistencias se conserva.
 */
export function DesbloquearModal({ miembroId, miembroNombre, onClose, onDesbloqueado }: Props) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!motivo.trim()) {
      toast.error('Indicá el motivo del desbloqueo.');
      return;
    }
    setSaving(true);
    try {
      await actualizarMiembro(miembroId, { unblock: true, motivo: motivo.trim() });
      toast.success('Miembro desbloqueado.');
      onDesbloqueado();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo desbloquear.');
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
        style={{ maxWidth: '420px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">DESBLOQUEAR MIEMBRO</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: '0 0 16px' }}>
          Se levanta la restricción para reservar de <strong>{miembroNombre}</strong>. El
          contador de inasistencias se conserva.
        </p>

        <MotivoField
          opciones={MOTIVOS_DESBLOQUEO}
          onChange={setMotivo}
          label="Motivo del desbloqueo"
          idPrefix="desb-motivo"
        />

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : <><Unlock size={15} aria-hidden="true" /> Desbloquear</>}
          </button>
        </div>
      </form>
    </div>
  );
}
