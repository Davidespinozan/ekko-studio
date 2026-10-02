import { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { iniciarOnboardingConnect, obtenerEstadoConnect, type ConnectStatus } from '../lib/connectService';
import { RevisionesFinancieras } from '../components/cobros/RevisionesFinancieras';

/**
 * Cobros — Stripe Connect del estudio. El admin activa los cobros (onboarding
 * hospedado por Stripe) y luego ve su cuenta vinculada, banco de depósito,
 * balance y el link al panel de Stripe para gestionar todo.
 */

function pesos(centavos: number, moneda: string): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')} ${moneda}`;
}

function intervaloLabel(intervalo: string | null | undefined): string {
  switch (intervalo) {
    case 'daily': return 'Diario';
    case 'weekly': return 'Semanal';
    case 'monthly': return 'Mensual';
    case 'manual': return 'Manual';
    default: return '—';
  }
}

function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline' }}>
      <span style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13.5px', color: 'var(--ek-ink)', textAlign: 'right', fontFamily: mono ? 'var(--ek-font-mono)' : undefined, wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  );
}

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
        window.location.href = res.url;
        return;
      }
      toast.error('No pudimos iniciar la activación.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos iniciar la activación de cobros.');
    } finally {
      setActivando(false);
    }
  }

  const desconectada = status?.desconectada === true;
  const listo = status?.charges_enabled === true && !desconectada;
  const enProceso = status?.connected === true && !listo && !desconectada;
  const cuentaMask = status?.account_id ? `acct ···· ${status.account_id.slice(-4)}` : '—';

  return (
    <div style={{ maxWidth: '640px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>PAGOS</p>
      <h1 className="ek-h2" style={{ marginBottom: '6px' }}>Cobros online</h1>
      <p className="ek-body-muted" style={{ marginBottom: '24px' }}>
        Los pagos con tarjeta caen <strong>directo a tu cuenta bancaria</strong>; nosotros solo conectamos la app.
      </p>

      {cargando ? (
        <div className="ek-card"><Spinner label="Cargando estado…" /></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Estado de la conexión */}
          <div className="ek-card" style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
            {listo
              ? <CheckCircle2 size={24} style={{ color: 'var(--ek-success)', flexShrink: 0 }} aria-hidden="true" />
              : <AlertCircle size={24} style={{ color: 'var(--ek-warning)', flexShrink: 0 }} aria-hidden="true" />}
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: '15px' }}>
                {desconectada ? 'Cuenta de Stripe desconectada' : listo ? 'Cobros activados' : enProceso ? 'Activación pendiente' : 'Cobros no activados'}
              </p>
              <p className="ek-body-muted" style={{ margin: '4px 0 14px', fontSize: '13.5px' }}>
                {desconectada
                  ? 'El estudio desautorizó la conexión con Stripe. No se pueden iniciar cobros nuevos hasta reconectar; las membresías vigentes no cambian.'
                  : listo
                    ? 'Ya puedes recibir pagos online. Los depósitos llegan solos a tu banco.'
                    : enProceso
                      ? 'Empezaste el formulario de Stripe pero falta completarlo. Continúa para poder cobrar.'
                      : 'Conecta tu cuenta para empezar a cobrar online (un formulario corto, una sola vez).'}
              </p>
              {!listo && (
                <button type="button" className="ek-cta ek-cta--gold" onClick={activar} disabled={activando}>
                  {activando ? <Spinner size={16} /> : <><CreditCard size={16} aria-hidden="true" /> {desconectada ? 'Reconectar cuenta' : enProceso ? 'Continuar activación' : 'Activar cobros'} <ExternalLink size={14} aria-hidden="true" /></>}
                </button>
              )}
              {status?.reason === 'stripe_pendiente' && (
                <p className="ek-helper-text" style={{ marginTop: '10px' }}>
                  (Stripe no está configurado en este entorno todavía.)
                </p>
              )}
            </div>
          </div>

          {/* PKG-01G: reembolsos / disputas / desconexión → revisión humana, sin mutar derechos. */}
          <RevisionesFinancieras />

          {status?.connected && !desconectada && (
            <>
              {/* Cuenta vinculada */}
              <div className="ek-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 4px' }}>CUENTA VINCULADA</p>
                <InfoRow label="Negocio" value={status.business_name || '—'} />
                <InfoRow label="Email" value={status.email || '—'} />
                <InfoRow label="País" value={status.pais || '—'} />
                <InfoRow label="ID de cuenta" value={cuentaMask} mono />
                <InfoRow
                  label="Estado"
                  value={
                    <span style={{ color: listo ? 'var(--ek-success)' : 'var(--ek-warning)', fontWeight: 600 }}>
                      {listo ? 'Puede cobrar' : 'Falta completar'}
                    </span>
                  }
                />
              </div>

              {/* Depósitos */}
              <div className="ek-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 4px' }}>DEPÓSITOS A TU BANCO</p>
                <InfoRow
                  label="Cuenta bancaria"
                  value={status.bank?.last4
                    ? `${status.bank.bank_name || 'Banco'} ···· ${status.bank.last4}`
                    : 'Sin cuenta registrada'}
                />
                <InfoRow label="Frecuencia" value={intervaloLabel(status.payout_interval)} />
                {status.payouts_enabled === false && (
                  <p className="ek-body-faint" style={{ margin: 0, fontSize: '12px', color: 'var(--ek-warning)' }}>
                    Los depósitos aún no están habilitados — completa tus datos en Stripe.
                  </p>
                )}
                {status.balance && (
                  <>
                    <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '4px 0' }} />
                    <InfoRow label="Disponible" value={pesos(status.balance.disponible_centavos, status.balance.moneda)} />
                    <InfoRow label="En camino" value={pesos(status.balance.pendiente_centavos, status.balance.moneda)} />
                  </>
                )}
              </div>

              {/* Administrar */}
              <div className="ek-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>ADMINISTRAR</p>
                <p className="ek-body-muted" style={{ margin: 0, fontSize: '13px' }}>
                  En el panel de Stripe cambias tu cuenta bancaria, ves los depósitos y descargas reportes.
                </p>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {status.dashboard_url && (
                    <a href={status.dashboard_url} target="_blank" rel="noopener noreferrer" className="ek-cta ek-cta--gold" style={{ minHeight: '44px' }}>
                      Abrir panel de Stripe <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  )}
                  <button type="button" onClick={activar} disabled={activando} className="ek-cta ek-cta--secondary" style={{ minHeight: '44px' }}>
                    {activando ? <Spinner size={16} /> : 'Actualizar datos / cambiar cuenta'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
