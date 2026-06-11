import { useState, FormEvent } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { corregirCheckin, MOTIVOS_CORREGIR_CHECKIN } from '../lib/accionesReserva';
import { MotivoField } from './MotivoField';
import type { ReservaInfo } from './MarcarNoShowModal';

interface Props {
  reserva: ReservaInfo;
  onClose: () => void;
  onDone: () => void;
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Deshace un check-in mal hecho (Bloque D). La reserva vuelve a 'confirmada' y
 * se limpian las columnas de check-in. Limitado al mismo día (lo valida el
 * backend). Motivo obligatorio → audit_log.
 */
export function CorregirCheckinModal({ reserva, onClose, onDone }: Props) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!motivo.trim()) {
      toast.error('Indicá el motivo de la corrección.');
      return;
    }
    setSaving(true);
    try {
      await corregirCheckin(reserva.id, motivo.trim());
      toast.success('Check-in corregido. La reserva volvió a confirmada.');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo corregir el check-in.');
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
          <p className="ek-eyebrow ek-eyebrow--mustard">CORREGIR CHECK-IN</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div
          style={{
            background: 'var(--ek-bg-soft)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-sm)',
            padding: '10px 14px',
            marginBottom: '14px'
          }}
        >
          <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ek-ink)', margin: 0 }}>
            {reserva.miembro_nombre}
          </p>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 0' }}>
            {reserva.folio} · {reserva.recurso_nombre} · {hora(reserva.slot_inicio)}
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            background: 'var(--ek-bg-soft)',
            border: '0.5px solid var(--ek-mustard-dim)',
            borderRadius: 'var(--ek-r-sm)',
            padding: '10px 12px',
            marginBottom: '16px'
          }}
        >
          <RotateCcw size={16} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, lineHeight: 1.45 }}>
            Esto deshace el check-in: la reserva vuelve a <strong>confirmada</strong>. Solo se
            puede corregir un check-in del mismo día.
          </p>
        </div>

        <MotivoField
          opciones={MOTIVOS_CORREGIR_CHECKIN}
          onChange={setMotivo}
          label="Motivo de la corrección"
          idPrefix="cc-motivo"
        />

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : 'Corregir check-in'}
          </button>
        </div>
      </form>
    </div>
  );
}
