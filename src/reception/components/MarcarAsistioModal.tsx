import { useState, FormEvent } from 'react';
import { X, UserCheck } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { marcarAsistio, MOTIVOS_ASISTIO } from '../lib/accionesReserva';
import { MotivoField } from './MotivoField';
import type { ReservaInfo } from './MarcarNoShowModal';
import { ZONA_ESTUDIO } from '@shared/lib/timezone';

interface Props {
  reserva: ReservaInfo & { status: string };
  onClose: () => void;
  onDone: () => void;
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { timeZone: ZONA_ESTUDIO, hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * "Sí asistió": corrige un no_show cuando el miembro sí vino y nadie le hizo el
 * check-in. Revierte la falta y, si el bloqueo se debía a ella, lo levanta.
 * Motivo obligatorio → audit_log. R2-A: solo desde no_show (una cancelada no se
 * revive); la transición completa la hace el servidor en una transacción.
 */
export function MarcarAsistioModal({ reserva, onClose, onDone }: Props) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!motivo.trim()) {
      toast.error('Indica el motivo de la corrección.');
      return;
    }
    setSaving(true);
    try {
      await marcarAsistio(reserva.id, motivo.trim());
      toast.success('Asistencia corregida: la falta se revirtió.');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo corregir la asistencia.');
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
          <p className="ek-eyebrow ek-eyebrow--mustard">SÍ ASISTIÓ</p>
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
          <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--ek-ink)', margin: 0 }}>{reserva.miembro_nombre}</p>
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
          <UserCheck size={16} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0, lineHeight: 1.45 }}>
            La reserva pasa a <strong>asistió</strong> con check-in de ahora. La falta se revierte y, si el
            bloqueo era por esta falta, se levanta. No se cobra ni se devuelve ningún crédito.
          </p>
        </div>

        <MotivoField opciones={MOTIVOS_ASISTIO} onChange={setMotivo} label="Motivo de la corrección" idPrefix="asistio-motivo" />

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : 'Marcar que sí asistió'}
          </button>
        </div>
      </form>
    </div>
  );
}
