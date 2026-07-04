import { useState } from 'react';
import { X, UserPlus } from 'lucide-react';
import { PaymentModal } from '@shared/components/PaymentModal';
import { crearPagoInvitados } from '@shared/lib/checkout';
import { useToast } from '@shared/hooks/useToast';

/**
 * Pagar invitados EXTRA de una reserva YA creada (Stripe, tarjeta guardada).
 * Paso 1: elegir cuántos. Paso 2: PaymentModal con el total. Se usa desde
 * "Mis reservas". Todo por Stripe — nada de efectivo/terminal.
 */
interface Props {
  reservaId: string;
  precioExtraCentavos: number;
  /** Cuántos más puede pagar (tope del estudio − ya pagados). */
  maxCantidad: number;
  onClose: () => void;
  onPagado: () => void;
}

export function PagarInvitadosExtra({ reservaId, precioExtraCentavos, maxCantidad, onClose, onPagado }: Props) {
  const toast = useToast();
  const tope = Math.max(1, maxCantidad);
  const [cantidad, setCantidad] = useState(1);
  const [pagando, setPagando] = useState(false);
  const precioPesos = Math.round(precioExtraCentavos / 100);

  if (pagando) {
    return (
      <PaymentModal
        precio={precioPesos * cantidad}
        titulo="Invitados extra"
        subtitulo={`${cantidad} ${cantidad === 1 ? 'invitado' : 'invitados'} × $${precioPesos.toLocaleString('es-MX')} = $${(precioPesos * cantidad).toLocaleString('es-MX')}`}
        pedirNombre={false}
        fetchIntent={() => crearPagoInvitados(reservaId, cantidad)}
        onClose={onClose}
        onPagado={() => { toast.success('¡Invitados extra pagados!'); onPagado(); }}
      />
    );
  }

  return (
    // Elegir cantidad; cierra solo con ✕ (paso previo a un pago).
    <div className="ek-backdrop" role="dialog" aria-modal="true">
      <div className="ek-card" style={{ maxWidth: '400px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard"><UserPlus size={12} aria-hidden="true" /> INVITADOS EXTRA</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="ek-body-muted" style={{ margin: '0 0 18px', fontSize: '14px' }}>
          ${precioPesos.toLocaleString('es-MX')} por invitado. Se cobra a tu tarjeta.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'center', marginBottom: '14px' }}>
          <button
            type="button"
            onClick={() => setCantidad(Math.max(1, cantidad - 1))}
            disabled={cantidad === 1}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
          >
            −
          </button>
          <span style={{ fontSize: '1.6rem', fontWeight: 700, minWidth: '48px', textAlign: 'center' }}>{cantidad}</span>
          <button
            type="button"
            onClick={() => setCantidad(Math.min(tope, cantidad + 1))}
            disabled={cantidad >= tope}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
          >
            +
          </button>
        </div>

        <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => setPagando(true)}>
          Pagar ${(precioPesos * cantidad).toLocaleString('es-MX')}
        </button>
      </div>
    </div>
  );
}
