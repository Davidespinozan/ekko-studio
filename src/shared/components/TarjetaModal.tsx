import { useEffect, useMemo, useRef, useState } from 'react';
import { loadStripe, type Appearance } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { X, CreditCard } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';
import { crearSetupIntent, actualizarTarjeta } from '@shared/lib/checkout';

/**
 * Modal IN-APP para registrar/actualizar la tarjeta con Stripe Elements
 * (SetupIntent sobre la cuenta conectada) — sin ir al portal de Stripe. Al
 * confirmar, fija la tarjeta como default del customer y de la suscripción.
 */

const PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

const appearance: Appearance = {
  theme: 'night',
  variables: {
    colorPrimary: '#e5b829',
    colorBackground: '#141416',
    colorText: '#ededea',
    colorTextSecondary: '#8a8a86',
    colorDanger: '#e5484d',
    fontFamily: 'Inter, system-ui, sans-serif',
    borderRadius: '13px'
  },
  rules: {
    '.Input': { border: '0.5px solid rgba(255, 255, 255, 0.12)', backgroundColor: '#060607' },
    '.Input:focus': { border: '0.5px solid #e5b829', boxShadow: '0 0 0 3px rgba(229, 184, 41, 0.20)' },
    '.Label': { color: '#8a8a86' },
    '.Tab': { border: '0.5px solid rgba(255, 255, 255, 0.12)' },
    '.Tab--selected': { borderColor: '#e5b829' }
  }
};

interface Props {
  onClose: () => void;
  onGuardada: () => void;
}

export function TarjetaModal({ onClose, onGuardada }: Props) {
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
    crearSetupIntent()
      .then((res) => {
        if (res.clientSecret && res.account) {
          setClientSecret(res.clientSecret);
          setAccount(res.account);
          setEstado('listo');
        } else if (res.reason === 'cobros_no_activos') {
          setEstado('pendiente');
          setMsg('El estudio todavía no activó los cobros online.');
        } else if (res.reason === 'stripe_pendiente') {
          setEstado('pendiente');
          setMsg('Los pagos online todavía no están configurados.');
        } else {
          setEstado('error');
          setMsg('No pudimos abrir el formulario. Probá de nuevo.');
        }
      })
      .catch((e) => {
        setEstado('error');
        setMsg(e instanceof Error ? e.message : 'No pudimos abrir el formulario.');
      });
  }, []);

  const stripePromise = useMemo(
    () => (PK && account ? loadStripe(PK, { stripeAccount: account }) : null),
    [account]
  );

  return (
    <div className="ek-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="ek-card"
        style={{ maxWidth: '440px', width: '100%', maxHeight: '92vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard"><CreditCard size={12} aria-hidden="true" /> MÉTODO DE PAGO</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, margin: '0 0 18px', letterSpacing: '-0.02em' }}>
          Actualizar tarjeta
        </h3>

        {estado === 'cargando' && <Spinner label="Preparando el formulario…" />}
        {(estado === 'pendiente' || estado === 'error') && (
          <p className="ek-body-muted" style={{ fontSize: '14px', color: estado === 'error' ? 'var(--ek-danger)' : undefined }}>
            {msg}
          </p>
        )}
        {estado === 'listo' && clientSecret && stripePromise && (
          <Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
            <TarjetaForm onGuardada={onGuardada} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function TarjetaForm({ onGuardada }: { onGuardada: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [procesando, setProcesando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submitting = useRef(false);

  async function guardar(e: React.FormEvent) {
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
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: 'if_required'
      });
      if (error) {
        setMsg(error.message ?? 'No se pudo guardar la tarjeta.');
        return;
      }
      const pmId = typeof setupIntent?.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent?.payment_method?.id;
      if (!pmId) {
        setMsg('No pudimos leer la tarjeta. Probá de nuevo.');
        return;
      }
      await actualizarTarjeta(pmId);
      onGuardada();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Error al guardar la tarjeta.');
    } finally {
      submitting.current = false;
      setProcesando(false);
    }
  }

  return (
    <form onSubmit={guardar}>
      <PaymentElement options={{ layout: 'tabs' }} />
      {msg && <p style={{ color: 'var(--ek-danger)', fontSize: '13px', marginTop: '10px' }}>{msg}</p>}
      <button type="submit" className="ek-cta ek-cta--gold ek-cta--full" style={{ marginTop: '18px' }} disabled={!stripe || procesando}>
        {procesando ? <Spinner size={16} /> : 'Guardar tarjeta'}
      </button>
      <p className="ek-helper-text" style={{ marginTop: '10px', textAlign: 'center' }}>
        Protegido por Stripe. Tus datos de tarjeta no pasan por EKKO.
      </p>
    </form>
  );
}
