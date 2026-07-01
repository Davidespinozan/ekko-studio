import { useEffect, useMemo, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import { X, Lock } from 'lucide-react';
import { backendPost } from '@shared/lib/backend';
import { Spinner } from '@shared/components/Spinner';

/**
 * Modal de pago de EKKO con el Embedded Checkout de Stripe (Connect). El miembro
 * paga SIN salir de la app; el formulario va embebido en el modal, sobre la
 * CUENTA CONECTADA del estudio (direct charge → el dinero cae directo al estudio).
 * La activación la dispara el webhook de Connect. Patrón portado de SALA.
 */

const PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

interface Sesion {
  client_secret?: string;
  account?: string;
  activated?: boolean;
  reason?: string;
}

interface Props {
  tierSlug: string;
  tierNombre: string;
  precio: number;
  esPaquete?: boolean;
  onClose: () => void;
  onPagado: () => void;
}

export function PaymentModal({ tierSlug, tierNombre, precio, esPaquete, onClose, onPagado }: Props) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'pendiente' | 'error'>('cargando');
  const [msg, setMsg] = useState('');
  const fetched = useRef(false);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    if (!PK) {
      setEstado('pendiente');
      setMsg('Los pagos online todavía no están configurados.');
      return;
    }
    backendPost<Sesion>('suscribir-membresia', { tier: tierSlug, embedded: true })
      .then((res) => {
        if (res.activated) return onPagado();
        if (res.client_secret && res.account) {
          setClientSecret(res.client_secret);
          setAccount(res.account);
          setEstado('listo');
        } else if (res.reason === 'cobros_no_activos') {
          setEstado('pendiente');
          setMsg('El estudio todavía no activó los cobros online. Acercate a recepción para activar tu plan.');
        } else if (res.reason === 'stripe_pendiente') {
          setEstado('pendiente');
          setMsg('Los pagos online todavía no están configurados. Acercate a recepción.');
        } else {
          setEstado('error');
          setMsg('No pudimos abrir el pago. Probá de nuevo.');
        }
      })
      .catch((e) => {
        setEstado('error');
        setMsg(e instanceof Error ? e.message : 'No pudimos abrir el pago.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierSlug]);

  // Stripe.js inicializado SOBRE la cuenta conectada (direct charges).
  const stripePromise = useMemo(
    () => (PK && account ? loadStripe(PK, { stripeAccount: account }) : null),
    [account]
  );

  return (
    <div className="ek-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '92vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard"><Lock size={12} aria-hidden="true" /> PAGO SEGURO</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
          {tierNombre}
        </h3>
        <p className="ek-body-muted" style={{ margin: '0 0 18px', fontSize: '14px' }}>
          ${precio.toLocaleString('es-MX')} {esPaquete ? '· pago único' : '/mes'}
        </p>

        {estado === 'cargando' && <Spinner label="Preparando el pago…" />}
        {(estado === 'pendiente' || estado === 'error') && (
          <p className="ek-body-muted" style={{ fontSize: '14px', color: estado === 'error' ? 'var(--ek-danger)' : undefined }}>
            {msg}
          </p>
        )}
        {estado === 'listo' && clientSecret && stripePromise && (
          <EmbeddedCheckoutProvider
            stripe={stripePromise}
            options={{ clientSecret, onComplete: () => onPagado() }}
          >
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        )}
      </div>
    </div>
  );
}
