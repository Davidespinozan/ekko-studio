import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useReglaCancelacion, puedeCancelarReserva } from '@member/hooks/useReglaCancelacion';
import { CancelarMiReservaModal } from './CancelarMiReservaModal';

export interface ReservaCancelable {
  id: string;
  slot_inicio: string;
  folio: string;
  recurso_nombre: string;
}

interface Props {
  reserva: ReservaCancelable;
  onCancelada: () => void;
}

function getWhatsappNumber(tenantConfig: unknown): string | null {
  if (!tenantConfig || typeof tenantConfig !== 'object') return null;
  const contacto = (tenantConfig as Record<string, unknown>).contacto;
  if (!contacto || typeof contacto !== 'object') return null;
  const numero = (contacto as Record<string, unknown>).whatsapp_e164;
  if (typeof numero !== 'string') return null;
  const limpio = numero.replace(/\D/g, '');
  return limpio.length >= 10 ? limpio : null;
}

export function BotonCancelarReserva({ reserva, onCancelada }: Props) {
  const tenant = useTenant();
  const { cancelacionMinHorasAntes } = useReglaCancelacion();
  const [modalOpen, setModalOpen] = useState(false);

  const resultado = useMemo(
    () => puedeCancelarReserva(reserva.slot_inicio, cancelacionMinHorasAntes),
    [reserva.slot_inicio, cancelacionMinHorasAntes]
  );

  if (!resultado.puede) {
    const whatsapp = getWhatsappNumber(tenant.config);
    const mensaje = `Hola, necesito cancelar mi reserva del ${new Date(reserva.slot_inicio).toLocaleString('es-MX', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })} en ${reserva.recurso_nombre} (folio ${reserva.folio}).`;
    const waUrl = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(mensaje)}` : null;

    return (
      <div
        style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          lineHeight: 1.45
        }}
      >
        <span>No se puede cancelar: {resultado.razon}.</span>
        {waUrl && (
          <>
            {' '}
            <a
              href={waUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: 'var(--ek-mustard)',
                textDecoration: 'underline',
                fontWeight: 500
              }}
            >
              Contactar al estudio
            </a>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--ek-danger)',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          minHeight: '44px',
          padding: '4px 8px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          textDecoration: 'underline',
          textUnderlineOffset: '3px'
        }}
      >
        <X size={13} aria-hidden="true" /> Cancelar reserva
      </button>

      {modalOpen && (
        <CancelarMiReservaModal
          reserva={{
            id: reserva.id,
            slot_inicio: reserva.slot_inicio,
            recurso_nombre: reserva.recurso_nombre,
            folio: reserva.folio
          }}
          onClose={() => setModalOpen(false)}
          onCancelada={onCancelada}
        />
      )}
    </>
  );
}
