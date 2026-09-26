import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '@shared/hooks/useToast';
import { cancelarReserva } from '@member/hooks/useReservas';
import { formatFechaHoraEnZona } from '@shared/lib/timezone';
import { ContactoEstudio } from '@shared/components/ContactoEstudio';

export interface ReservaParaCancelar {
  id: string;
  slot_inicio: string;
  recurso_nombre: string;
  folio: string;
  invitados_extra_pagados?: number | null;
}

interface Props {
  reserva: ReservaParaCancelar;
  onClose: () => void;
  onCancelada: () => void;
}

type Step = 'info' | 'confirm';

const SUGERENCIAS = ['Cambio de planes', 'Salud', 'Trabajo', 'Otro'] as const;

function formatearFecha(iso: string): string {
  // Zona del ESTUDIO (la hora que el miembro eligió al reservar).
  return formatFechaHoraEnZona(iso, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
}

export function CancelarMiReservaModal({ reserva, onClose, onCancelada }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('info');
  const [chipActivo, setChipActivo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
  const target = typeof document !== 'undefined' ? document.body : null;
  // M16: los invitados extra se cobraron aparte y el sistema NO los reembolsa
  // solo. Se avisa antes de confirmar y se da el canal para pedirlo.
  const invitadosPagados = reserva.invitados_extra_pagados ?? 0;

  function handleChip(sug: string) {
    setChipActivo(sug);
    // Autocompleta textarea si está vacío o coincidía con otro chip
    if (!motivo.trim() || SUGERENCIAS.some((s) => s === motivo.trim())) {
      setMotivo(sug);
    }
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);

    const motivoFinal = motivo.trim() || chipActivo || undefined;

    const { error: err } = await cancelarReserva({
      reserva_id: reserva.id,
      motivo: motivoFinal
    });

    if (err) {
      toast.error(`No se pudo cancelar: ${err}`);
      setSubmitting(false);
      return;
    }

    toast.success('Tu reserva fue cancelada');
    onCancelada();
    onClose();
  }

  if (!target) return null;

  return createPortal(
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancelar-mi-reserva-title"
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
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '480px',
          width: '100%',
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: 'clamp(16px, 5vw, 28px)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow" style={{ marginBottom: '6px', color: 'var(--ek-danger)' }}>
          {step === 'info' ? 'CANCELAR RESERVA' : 'CONFIRMAR CANCELACIÓN'}
        </p>
        <h3
          id="cancelar-mi-reserva-title"
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            margin: 0,
            marginBottom: '14px',
            letterSpacing: '-0.02em'
          }}
        >
          {step === 'info' ? '¿Quieres cancelar esta reserva?' : '¿Estás seguro?'}
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
            {reserva.recurso_nombre}
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '4px' }}>
            {fechaFmt}
          </p>
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: 0, fontFamily: 'var(--ek-font-mono)' }}>
            Folio: {reserva.folio}
          </p>
        </div>

        {step === 'info' && (
          <>
            <div style={{ marginBottom: '14px' }}>
              <p
                className="ek-label"
                style={{ marginBottom: '8px' }}
              >
                ¿Por qué cancelas? (opcional)
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                {SUGERENCIAS.map((sug) => {
                  const activo = chipActivo === sug;
                  return (
                    <button
                      key={sug}
                      type="button"
                      onClick={() => handleChip(sug)}
                      disabled={submitting}
                      style={{
                        padding: '10px 14px',
                        minHeight: '40px',
                        borderRadius: '999px',
                        border: `0.5px solid ${activo ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                        background: activo ? 'var(--ek-mustard-soft)' : 'transparent',
                        color: activo ? 'var(--ek-mustard)' : 'var(--ek-ink-muted)',
                        fontSize: '12px',
                        fontWeight: 500,
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {sug}
                    </button>
                  );
                })}
              </div>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className="ek-input"
                placeholder="Contanos un poco más (opcional)"
                rows={3}
                maxLength={280}
                disabled={submitting}
                style={{ resize: 'vertical', minHeight: '72px', fontFamily: 'inherit' }}
              />
              <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
                Tu motivo nos ayuda a mejorar. Solo lo ve el admin del estudio.
              </p>
            </div>

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
                onClick={() => setStep('confirm')}
                disabled={submitting}
                className="ek-cta"
                style={{
                  flex: 1,
                  background: 'var(--ek-danger-soft)',
                  color: 'var(--ek-danger)',
                  border: '0.5px solid var(--ek-danger)'
                }}
              >
                Continuar
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--ek-ink)',
                lineHeight: 1.55,
                marginBottom: '8px'
              }}
            >
              Al confirmar, esta reserva se cancelará y el horario quedará libre para otros miembros.
            </p>
            {invitadosPagados > 0 && (
              <div
                role="note"
                style={{
                  background: 'var(--ek-warning-soft, var(--ek-bg-elevated))',
                  border: '0.5px solid var(--ek-warning)',
                  borderRadius: 'var(--ek-r-md)',
                  padding: '10px 12px',
                  marginBottom: '12px',
                  fontSize: '13px',
                  lineHeight: 1.5
                }}
              >
                <p style={{ margin: 0, fontWeight: 600 }}>
                  Esta reserva tiene {invitadosPagados} {invitadosPagados === 1 ? 'invitado extra pagado' : 'invitados extra pagados'}.
                </p>
                <p style={{ margin: '4px 0 0', color: 'var(--ek-ink-muted)' }}>
                  Ese cobro no se devuelve automáticamente al cancelar.{' '}
                  <ContactoEstudio
                    enLinea
                    etiqueta="Escríbele al estudio"
                    mensaje={`Hola, voy a cancelar mi reserva del ${fechaFmt} (folio ${reserva.folio}) y tengo ${invitadosPagados} ${invitadosPagados === 1 ? 'invitado extra pagado' : 'invitados extra pagados'}. ¿Cómo procede el reembolso?`}
                  />{' '}
                  para acordar el reembolso.
                </p>
              </div>
            )}
            {(motivo.trim() || chipActivo) && (
              <div
                style={{
                  background: 'var(--ek-bg-elevated)',
                  border: '0.5px solid var(--ek-line)',
                  borderRadius: 'var(--ek-r-md)',
                  padding: '10px 12px',
                  marginBottom: '16px'
                }}
              >
                <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Motivo
                </p>
                <p style={{ fontSize: '13px', color: 'var(--ek-ink)', margin: 0 }}>
                  {motivo.trim() || chipActivo}
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setStep('info')}
                disabled={submitting}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Atrás
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="ek-cta"
                style={{
                  flex: 1,
                  background: 'var(--ek-danger-soft)',
                  color: 'var(--ek-danger)',
                  border: '0.5px solid var(--ek-danger)',
                  opacity: submitting ? 0.6 : 1
                }}
              >
                {submitting ? 'Cancelando…' : 'Sí, cancelar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    target
  );
}
