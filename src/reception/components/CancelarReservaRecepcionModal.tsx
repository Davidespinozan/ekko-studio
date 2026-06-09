import { useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { traducirErrorReserva } from '../lib/traducirErrorReserva';

export interface ReservaParaCancelar {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
}

interface Props {
  reserva: ReservaParaCancelar;
  miembroNombre: string;
  onClose: () => void;
  onCancelada: () => void;
}

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Confirmación de cancelación de la reserva de un miembro, desde recepción
 * (Sprint RP-3a). El RPC `cancelar_reserva_atomic` ya hace el resto (D3):
 * como recepción ≠ dueño, setea status='cancelada_admin' + cancelada_por
 * + notifica al miembro "por el estudio". El front solo llama.
 */
export function CancelarReservaRecepcionModal({
  reserva,
  miembroNombre,
  onClose,
  onCancelada
}: Props) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirmar() {
    if (submitting) return;
    setSubmitting(true);

    const { error } = await supabase.rpc('cancelar_reserva_atomic', {
      p_reserva_id: reserva.id,
      p_motivo: motivo.trim() || undefined
    });

    if (error) {
      toast.error(traducirErrorReserva(error.message));
      setSubmitting(false);
      return;
    }

    toast.success('Reserva cancelada. Se le notificó al miembro.');
    onCancelada();
    onClose();
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Cancelar reserva"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--ek-backdrop)',
        backdropFilter: 'blur(var(--ek-backdrop-blur))',
        WebkitBackdropFilter: 'blur(var(--ek-backdrop-blur))',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-danger)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '440px',
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: 'clamp(16px, 5vw, 28px)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '6px' }}>
          CANCELAR RESERVA
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '19px',
            fontWeight: 700,
            margin: 0,
            marginBottom: '12px',
            letterSpacing: '-0.02em'
          }}
        >
          ¿Cancelar la reserva de {miembroNombre}?
        </h3>

        <div
          style={{
            background: 'var(--ek-bg-elevated)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-md)',
            padding: '12px 14px',
            marginBottom: '16px'
          }}
        >
          <p style={{ fontSize: '14px', fontWeight: 600, margin: 0, marginBottom: '4px' }}>
            {reserva.recurso_nombre}
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
            {fechaHora(reserva.slot_inicio)}
          </p>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', marginBottom: '14px' }}>
          El miembro recibirá una notificación de que el estudio canceló su reserva.
        </p>

        <div className="ek-form-field" style={{ marginBottom: '20px' }}>
          <label className="ek-label">Motivo (opcional)</label>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="ek-input"
            placeholder="Ej. mantenimiento del estudio"
            maxLength={200}
            disabled={submitting}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1, minHeight: '44px' }}
          >
            Volver
          </button>
          <button
            type="button"
            onClick={handleConfirmar}
            disabled={submitting}
            className="ek-cta"
            style={{
              flex: 1,
              minHeight: '44px',
              background: 'var(--ek-danger-soft)',
              color: 'var(--ek-danger)',
              border: '0.5px solid var(--ek-danger)',
              opacity: submitting ? 0.6 : 1
            }}
          >
            {submitting ? 'Cancelando…' : 'Cancelar reserva'}
          </button>
        </div>
      </div>
    </div>
  );
}
