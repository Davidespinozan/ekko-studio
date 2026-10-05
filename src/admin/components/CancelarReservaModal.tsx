import { useEffect, useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { CopyButton } from '@shared/components/CopyButton';
import { cancelarReserva } from '../lib/crudHelpers';
import { CausaCancelacionSelector, type CausaCancelacion } from '@shared/components/reserva/CausaCancelacion';

export interface ReservaParaCancelar {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
  usuario_nombre: string;
  tier?: string | null;
}

interface Props {
  reserva: ReservaParaCancelar;
  onClose: () => void;
  onCancelled: () => void;
}

function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function primerNombre(nombre: string): string {
  return nombre.split(/\s+/).filter(Boolean)[0] ?? nombre;
}

export default function CancelarReservaModal({ reserva, onClose, onCancelled }: Props) {
  const { usuario } = useAuth();
  const toast = useToast();

  const [motivo, setMotivo] = useState('');
  const [typed, setTyped] = useState('');
  const [causa, setCausa] = useState<CausaCancelacion | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting]);

  const fechaFmt = formatearFecha(reserva.slot_inicio);
  const motivoOk = motivo.trim().length >= 5;
  const typedOk = typed === 'CANCELAR';
  const canSubmit = motivoOk && typedOk && causa !== null && !submitting;

  // R2-B (PKG-01Q): el mensaje sugerido dice quién canceló (antes siempre se
  // disculpaba como si hubiera sido el estudio).
  const mensajeWhatsapp =
    causa === 'miembro'
      ? `Hola ${primerNombre(reserva.usuario_nombre)}, como nos pediste, cancelamos tu reserva del ${fechaFmt} en ${reserva.recurso_nombre}. En la app verás el detalle de la cancelación y de tu crédito.`
      : `Hola ${primerNombre(reserva.usuario_nombre)}, te aviso que tuvimos que cancelar tu reserva del ${fechaFmt} en ${reserva.recurso_nombre}. Motivo: ${motivo || '[escribe el motivo arriba]'}. Disculpa las molestias, puedes reservar otra fecha desde la app.`;

  async function handleSubmit() {
    if (!usuario) return;
    if (!canSubmit || !causa) return;
    setSubmitting(true);
    setError(null);

    const { error: err } = await cancelarReserva({
      reservaId: reserva.id,
      motivo: motivo.trim(),
      causa
    });

    if (err) {
      setError(err);
      toast.error(`No se pudo cancelar: ${err}`);
      setSubmitting(false);
      return;
    }

    toast.success('Reserva cancelada.');
    onCancelled();
    onClose();
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
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
        padding: '20px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-danger)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '560px',
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: 'clamp(16px, 4vw, 24px)',
          boxShadow: 'var(--ek-shadow-modal)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '6px' }}>
          CANCELAR RESERVA
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            margin: 0,
            marginBottom: '8px',
            letterSpacing: '-0.02em'
          }}
        >
          Estás cancelando esta reserva
        </h3>

        <div
          style={{
            background: 'var(--ek-bg-elevated)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-md)',
            padding: '14px 16px',
            marginBottom: '20px'
          }}
        >
          <p style={{ fontSize: '14px', fontWeight: 600, margin: 0, marginBottom: '4px' }}>
            {reserva.usuario_nombre}
            {reserva.tier && (
              <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 400 }}> · {reserva.tier}</span>
            )}
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
            {reserva.recurso_nombre} · {fechaFmt}
          </p>
        </div>

        <div className="ek-form-field" style={{ marginBottom: '14px' }}>
          <label className="ek-label">Motivo de la cancelación *</label>
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            className="ek-input"
            placeholder="Ej. Mantenimiento del estudio"
            required
            minLength={5}
            disabled={submitting}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Este motivo se compartirá con el miembro.
          </p>
        </div>

        <CausaCancelacionSelector value={causa} onChange={setCausa} slotInicio={reserva.slot_inicio} disabled={submitting} />

        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '0 0 20px', lineHeight: 1.45 }}>
          Al miembro le llega el aviso por la app y por correo, con el motivo y lo que pasa con su crédito.
        </p>

        <div
          style={{
            background: 'var(--ek-mustard-soft)',
            border: '0.5px solid var(--ek-mustard-dim)',
            borderRadius: 'var(--ek-r-md)',
            padding: '14px 16px',
            marginBottom: '20px'
          }}
        >
          <p
            className="ek-eyebrow ek-eyebrow--mustard"
            style={{ fontSize: '10px', marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Lightbulb size={12} aria-hidden="true" />
            SUGERENCIA WHATSAPP
          </p>
          <p
            style={{
              fontSize: '13px',
              color: 'var(--ek-ink)',
              lineHeight: 1.55,
              margin: 0,
              marginBottom: '10px',
              fontFamily: 'var(--ek-font-mono)',
              background: 'var(--ek-bg)',
              padding: '10px 12px',
              borderRadius: 'var(--ek-r-sm)'
            }}
          >
            {mensajeWhatsapp}
          </p>
          <CopyButton text={mensajeWhatsapp} label="Copiar mensaje" copiedLabel="Mensaje copiado" />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', marginBottom: '6px' }}>
            Escribe <strong style={{ color: 'var(--ek-ink)' }}>CANCELAR</strong> para confirmar:
          </p>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="ek-input"
            placeholder="CANCELAR"
            style={{ fontFamily: 'var(--ek-font-mono)' }}
            disabled={submitting}
          />
        </div>

        {error && <p className="ek-error-text" style={{ marginBottom: '12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
            Volver
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="ek-cta"
            style={{
              flex: 1,
              background: 'var(--ek-danger-soft)',
              color: 'var(--ek-danger)',
              border: '0.5px solid var(--ek-danger)',
              opacity: canSubmit ? 1 : 0.5
            }}
          >
            {submitting ? 'Cancelando…' : 'Cancelar reserva'}
          </button>
        </div>
      </div>
    </div>
  );
}
