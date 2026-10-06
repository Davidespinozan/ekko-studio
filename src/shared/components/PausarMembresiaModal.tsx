import { useState, type FormEvent } from 'react';
import { X, PauseCircle, PlayCircle } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { backendPost } from '@shared/lib/backend';

interface Props {
  usuarioId: string;
  nombre: string | null;
  /** true = pausar; false = reanudar */
  pausar: boolean;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

export function pausarMembresia(usuario_id: string, pausar: boolean, motivo: string) {
  return backendPost<{ success: boolean; stripe_pausado: boolean; cobro_pendiente?: boolean; cobro_suspendido_por_sancion?: boolean }>(
    'stripe-pausar-membresia', { usuario_id, pausar, motivo });
}

/**
 * Pausar/reanudar la membresía de un miembro (viaje, lesión). Pausa el cobro en
 * Stripe y deja la cuenta sin reservas hasta reanudar. Motivo obligatorio
 * (audit_log). Lo usan admin y recepción.
 */
export function PausarMembresiaModal({ usuarioId, nombre, pausar, onClose, onDone }: Props) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (motivo.trim().length < 3) {
      toast.error('Indica el motivo (mínimo 3 caracteres).');
      return;
    }
    setSaving(true);
    try {
      const r = await pausarMembresia(usuarioId, pausar, motivo.trim());
      // PKG-02H: el cambio en EKKO ya quedó; lo de Stripe solo se afirma si se aplicó.
      if (r.cobro_pendiente) {
        toast.warning(
          pausar
            ? 'Membresía en pausa en EKKO. Stripe no confirmó la pausa del cobro: queda pendiente y se reintentará (ver Operación).'
            : 'Membresía reactivada en EKKO. Stripe no confirmó la reanudación del cobro: queda pendiente y se reintentará (ver Operación).',
          12_000
        );
      } else {
        toast.success(
          pausar
            ? `Membresía en pausa${r.stripe_pausado ? ' · cobro de Stripe detenido' : ''}.`
            : `Membresía reactivada${r.stripe_pausado ? ' · cobro de Stripe reanudado' : r.cobro_suspendido_por_sancion ? ' · el cobro sigue suspendido por la sanción' : ''}.`
        );
      }
      await onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar la membresía.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ek-backdrop" onClick={() => !saving && onClose()} role="dialog" aria-modal="true" aria-labelledby="pm-title">
      <form onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit} className="ek-card" style={{ maxWidth: '440px', width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <p id="pm-title" className="ek-eyebrow ek-eyebrow--mustard" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {pausar ? <PauseCircle size={14} aria-hidden="true" /> : <PlayCircle size={14} aria-hidden="true" />}
            {pausar ? 'PAUSAR MEMBRESÍA' : 'REANUDAR MEMBRESÍA'}
          </p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 10px' }}>{nombre ?? 'Miembro'}</p>
        <p className="ek-body-muted" style={{ fontSize: '13px', lineHeight: 1.5, margin: '0 0 14px' }}>
          {pausar
            ? 'Mientras esté en pausa no se le cobrará la mensualidad (Stripe detiene la facturación) y no podrá reservar. Se le avisa por la app.'
            : 'Se reanuda el cobro en Stripe y vuelve a poder reservar. Se le avisa por la app.'}
        </p>
        <label className="ek-label" style={{ display: 'block' }}>
          Motivo
          <input
            className="ek-input"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder={pausar ? 'Ej. Viaje de 3 semanas' : 'Ej. Regresó de viaje'}
            maxLength={200}
            autoFocus
          />
        </label>
        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : pausar ? 'Pausar' : 'Reanudar'}
          </button>
        </div>
      </form>
    </div>
  );
}
