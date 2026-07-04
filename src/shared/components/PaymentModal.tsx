import { useEffect, useMemo, useRef, useState } from 'react';
import { loadStripe, type Appearance } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { X, Lock } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';
import { crearPagoIntent, type PagoIntentResult } from '@shared/lib/checkout';
import { useAuth } from '@shared/hooks/useAuth';

/**
 * Modal de pago PROPIO de EKKO con Stripe Elements (<PaymentElement>) sobre la
 * CUENTA CONECTADA del estudio (direct charge). Formulario oscuro con los tokens
 * de EKKO — el usuario NO sale de la app y no ve la UI blanca de Stripe. La
 * activación la dispara el webhook de Connect.
 */

const PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

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
  /** Plan a pagar (membresía). Omitir si se usa `fetchIntent` (p. ej. invitados). */
  tierSlug?: string;
  tierNombre?: string;
  precio: number;
  esPaquete?: boolean;
  /** Overrides de presentación cuando no es una membresía. */
  titulo?: string;
  subtitulo?: string;
  /** Pedir "Nombre en la tarjeta" (default true; los add-ons no lo necesitan). */
  pedirNombre?: boolean;
  /** Fuente del clientSecret; default: crearPagoIntent(tierSlug). */
  fetchIntent?: () => Promise<PagoIntentResult>;
  onClose: () => void;
  onPagado: () => void;
}

export function PaymentModal({ tierSlug, tierNombre, precio, esPaquete, titulo, subtitulo, pedirNombre = true, fetchIntent, onClose, onPagado }: Props) {
  const { usuario } = useAuth();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [customerSessionSecret, setCustomerSessionSecret] = useState<string | null>(null);
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
    const obtener = fetchIntent ?? (() => crearPagoIntent(tierSlug ?? ''));
    obtener()
      .then((res) => {
        if (res.clientSecret && res.account) {
          setClientSecret(res.clientSecret);
          setCustomerSessionSecret(res.customerSessionClientSecret ?? null);
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
          setMsg('No pudimos abrir el pago. Prueba de nuevo.');
        }
      })
      .catch((e) => {
        setEstado('error');
        setMsg(e instanceof Error ? e.message : 'No pudimos abrir el pago.');
      });
    // El guard `fetched.current` asegura una sola llamada; no re-ejecutar por
    // identidad de fetchIntent (viene inline del caller).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierSlug]);

  // Stripe.js inicializado SOBRE la cuenta conectada (direct charges).
  const stripePromise = useMemo(
    () => (PK && account ? loadStripe(PK, { stripeAccount: account }) : null),
    [account]
  );

  // Sin cierre por clic en el fondo: en un pago un clic accidental perdía el
  // progreso. Solo cierra con el botón ✕.
  return (
    <div className="ek-backdrop" role="dialog" aria-modal="true">
      <div
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
          {titulo ?? tierNombre}
        </h3>
        <p className="ek-body-muted" style={{ margin: '0 0 18px', fontSize: '14px' }}>
          {subtitulo ?? `$${precio.toLocaleString('es-MX')} ${esPaquete ? '· pago único' : '/mes'}`}
        </p>

        {estado === 'cargando' && <Spinner label="Preparando el pago…" />}
        {(estado === 'pendiente' || estado === 'error') && (
          <p className="ek-body-muted" style={{ fontSize: '14px', color: estado === 'error' ? 'var(--ek-danger)' : undefined }}>
            {msg}
          </p>
        )}
        {estado === 'listo' && clientSecret && stripePromise && (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance,
              ...(customerSessionSecret ? { customerSessionClientSecret: customerSessionSecret } : {})
            }}
          >
            <CheckoutForm onPagado={onPagado} nombreDefault={usuario?.nombre ?? ''} pedirNombre={pedirNombre} />
          </Elements>
        )}
      </div>
    </div>
  );
}

function CheckoutForm({ onPagado, nombreDefault, pedirNombre }: { onPagado: () => void; nombreDefault: string; pedirNombre: boolean }) {
  const stripe = useStripe();
  const elements = useElements();
  const [procesando, setProcesando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [nombre, setNombre] = useState(nombreDefault);
  const submitting = useRef(false);

  async function pagar(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || submitting.current) return;
    submitting.current = true;
    setProcesando(true);
    setMsg(null);
    try {
      const { error: submitErr } = await elements.submit();
      if (submitErr) {
        setMsg(submitErr.message ?? 'Revisa los datos de la tarjeta.');
        return;
      }
      // El nombre del titular lo recogemos nosotros (Stripe oculta el campo en
      // tarjeta). Se adjunta a la tarjeta NUEVA vía payment_method_data; si el
      // miembro elige una tarjeta GUARDADA, Stripe usa esa y este dato no aplica.
      const nombreTrim = nombre.trim();
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/app/perfil?suscripcion=ok`,
          ...(nombreTrim ? { payment_method_data: { billing_details: { name: nombreTrim } } } : {})
        },
        redirect: 'if_required'
      });
      if (error) {
        setMsg(error.message ?? 'No se pudo procesar el pago.');
        return;
      }
      onPagado();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Error al procesar el pago.');
    } finally {
      submitting.current = false;
      setProcesando(false);
    }
  }

  return (
    <form onSubmit={pagar}>
      {pedirNombre && (
        <label style={{ display: 'block', marginBottom: '12px' }}>
          <span style={{ display: 'block', fontSize: '13px', color: '#888888', marginBottom: '6px' }}>
            Nombre en la tarjeta
          </span>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoComplete="cc-name"
            placeholder="Como aparece en la tarjeta"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '12px 14px',
              fontSize: '15px',
              color: '#f5f1e8',
              background: '#0a0a0a',
              border: '0.5px solid rgba(245, 241, 232, 0.14)',
              borderRadius: '13px',
              outline: 'none'
            }}
          />
        </label>
      )}
      <PaymentElement options={{ layout: 'tabs', fields: { billingDetails: { name: 'never' } } }} />
      {msg && <p style={{ color: 'var(--ek-danger)', fontSize: '13px', marginTop: '10px' }}>{msg}</p>}
      <button type="submit" className="ek-cta ek-cta--gold ek-cta--full" style={{ marginTop: '18px' }} disabled={!stripe || procesando}>
        {procesando ? <Spinner size={16} /> : 'Pagar ahora'}
      </button>
      <p className="ek-helper-text" style={{ marginTop: '10px', textAlign: 'center' }}>
        Pago protegido por Stripe. Tus datos de tarjeta no pasan por EKKO.
      </p>
    </form>
  );
}
