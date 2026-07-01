import { useEffect, useRef, useState } from 'react';
import { loadStripe, type Appearance } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { X, Lock } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { crearPagoIntent } from '@shared/lib/checkout';

/**
 * Modal de pago PROPIO de EKKO con Stripe Elements: el campo de tarjeta va
 * embebido (iframe seguro de Stripe) y estilizado con los tokens de EKKO — el
 * usuario NO sale a la página de Stripe. La activación la dispara el webhook.
 */

const PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
// loadStripe a nivel de módulo (una sola vez). Null si no hay llave pública.
const stripePromise = PUBLISHABLE_KEY ? loadStripe(PUBLISHABLE_KEY) : null;

const appearance: Appearance = {
  theme: 'night',
  variables: {
    colorPrimary: '#e5b829',
    colorBackground: '#131313',
    colorText: '#f5f1e8',
    colorTextSecondary: '#888888',
    colorDanger: '#e5484d',
    fontFamily: 'Inter, system-ui, sans-serif',
    borderRadius: '13px'
  },
  rules: {
    '.Input': { border: '0.5px solid rgba(245, 241, 232, 0.14)', backgroundColor: '#0a0a0a' },
    '.Input:focus': { border: '0.5px solid #e5b829', boxShadow: '0 0 0 3px rgba(229, 184, 41, 0.20)' },
    '.Label': { color: '#888888' },
    '.Tab': { border: '0.5px solid rgba(245, 241, 232, 0.14)' },
    '.Tab--selected': { borderColor: '#e5b829' }
  }
};

interface Props {
  tierSlug: string;
  tierNombre: string;
  precio: number;
  esPaquete?: boolean;
  onClose: () => void;
  onPagado: () => void;
}

export function PaymentModal({ tierSlug, tierNombre, precio, esPaquete, onClose, onPagado }: Props) {
  const toast = useToast();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [pendiente, setPendiente] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetched = useRef(false); // evita doble intent en StrictMode

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    if (!stripePromise) {
      setPendiente(true);
      return;
    }
    crearPagoIntent(tierSlug)
      .then((res) => {
        if (res.reason === 'stripe_pendiente' || !res.clientSecret) setPendiente(true);
        else setClientSecret(res.clientSecret);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo iniciar el pago.'));
  }, [tierSlug]);

  return (
    <div className="ek-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '440px', width: '100%', maxHeight: '92vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
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

        {pendiente ? (
          <p className="ek-body-muted" style={{ fontSize: '14px' }}>
            El pago en línea todavía no está disponible. Acercate a recepción para activar tu plan.
          </p>
        ) : error ? (
          <p style={{ color: 'var(--ek-danger)', fontSize: '14px' }}>{error}</p>
        ) : !clientSecret ? (
          <Spinner label="Preparando el pago…" />
        ) : (
          <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
            <CheckoutForm onPagado={onPagado} onClose={onClose} toastError={(m) => toast.error(m)} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function CheckoutForm({
  onPagado,
  onClose,
  toastError
}: {
  onPagado: () => void;
  onClose: () => void;
  toastError: (m: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [procesando, setProcesando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submitting = useRef(false); // guard anti doble-submit (doble cobro)

  async function pagar(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting.current) return;
    submitting.current = true;
    setProcesando(true);
    setMsg(null);
    try {
      const { error: submitErr } = await elements.submit();
      if (submitErr) {
        setMsg(submitErr.message ?? 'Revisá los datos de la tarjeta.');
        return;
      }
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}/app/perfil?suscripcion=ok` },
        redirect: 'if_required'
      });
      if (error) {
        setMsg(error.message ?? 'No se pudo procesar el pago.');
        return;
      }
      // Pago confirmado. La membresía la activa el webhook (unos segundos).
      onPagado();
      onClose();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Error al procesar el pago.');
    } finally {
      submitting.current = false;
      setProcesando(false);
    }
  }

  return (
    <form onSubmit={pagar}>
      <PaymentElement options={{ layout: 'tabs' }} />
      {msg && (
        <p style={{ color: 'var(--ek-danger)', fontSize: '13px', marginTop: '10px' }}>{msg}</p>
      )}
      <button type="submit" className="ek-cta ek-cta--gold ek-cta--full" style={{ marginTop: '18px' }} disabled={!stripe || procesando}>
        {procesando ? <Spinner size={16} /> : 'Pagar ahora'}
      </button>
      <p className="ek-helper-text" style={{ marginTop: '10px', textAlign: 'center' }}>
        Pago protegido por Stripe. Tus datos de tarjeta no pasan por EKKO.
      </p>
    </form>
  );
}
