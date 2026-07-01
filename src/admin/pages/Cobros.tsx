import { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { iniciarOnboardingConnect, obtenerEstadoConnect, type ConnectStatus } from '../lib/connectService';

/**
 * Cobros — activación de Stripe Connect del estudio. El admin activa los cobros
 * (onboarding hospedado por Stripe), y desde ahí los miembros pagan online y el
 * dinero cae directo al banco del estudio.
 */
export default function Cobros() {
  const toast = useToast();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [cargando, setCargando] = useState(true);
  const [activando, setActivando] = useState(false);

  async function recargar() {
    try {
      setStatus(await obtenerEstadoConnect());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos consultar el estado de cobros.');
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void recargar();
    // Si volvemos del onboarding (?connect=done), refrescamos el estado.
    const p = new URLSearchParams(window.location.search).get('connect');
    if (p === 'done') toast.success('Volviste del formulario de Stripe. Verificando el estado…');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activar() {
    setActivando(true);
    try {
      const res = await iniciarOnboardingConnect();
      if (res.reason === 'stripe_pendiente') {
        toast.info('Stripe todavía no está configurado en este entorno.');
        return;
      }
      if (res.url) {
        window.location.href = res.url; // formulario hospedado por Stripe
        return;
      }
      toast.error('No pudimos iniciar la activación.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos iniciar la activación de cobros.');
    } finally {
      setActivando(false);
    }
  }

  const listo = status?.charges_enabled === true;
  const enProceso = status?.connected === true && !listo;

  return (
    <div style={{ maxWidth: '640px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>PAGOS</p>
      <h1 className="ek-h2" style={{ marginBottom: '6px' }}>Cobros online</h1>
      <p className="ek-body-muted" style={{ marginBottom: '24px' }}>
        Activá los pagos con tarjeta. El dinero cae <strong>directo a tu cuenta bancaria</strong>;
        nosotros solo conectamos la app.
      </p>

      {cargando ? (
        <div className="ek-card"><Spinner label="Cargando estado…" /></div>
      ) : (
        <div className="ek-card" style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
          {listo
            ? <CheckCircle2 size={24} style={{ color: 'var(--ek-success)', flexShrink: 0 }} aria-hidden="true" />
            : <AlertCircle size={24} style={{ color: 'var(--ek-warning)', flexShrink: 0 }} aria-hidden="true" />}
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 600, fontSize: '15px' }}>
              {listo ? 'Cobros activados' : enProceso ? 'Activación pendiente' : 'Cobros no activados'}
            </p>
            <p className="ek-body-muted" style={{ margin: '4px 0 14px', fontSize: '13.5px' }}>
              {listo
                ? 'Ya podés recibir pagos online. Los depósitos llegan solos a tu banco.'
                : enProceso
                  ? 'Empezaste el formulario de Stripe pero falta completarlo. Continuá para poder cobrar.'
                  : 'Conectá tu cuenta para empezar a cobrar online (un formulario corto, una sola vez).'}
            </p>
            {!listo && (
              <button type="button" className="ek-cta ek-cta--gold" onClick={activar} disabled={activando}>
                {activando ? <Spinner size={16} /> : <><CreditCard size={16} aria-hidden="true" /> {enProceso ? 'Continuar activación' : 'Activar cobros'} <ExternalLink size={14} aria-hidden="true" /></>}
              </button>
            )}
            {status?.reason === 'stripe_pendiente' && (
              <p className="ek-helper-text" style={{ marginTop: '10px' }}>
                (Stripe no está configurado en este entorno todavía.)
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
