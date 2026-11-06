import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ExternalLink, ShieldCheck } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';
import { useToast } from '@shared/hooks/useToast';
import {
  ESTADO_CARE,
  ORDEN_PLANES,
  PLANES_STRYV,
  STRYV_URL,
  fechaCare,
  irA,
  pesosCare,
  planDeRegreso,
  regresoDeStripe,
  stryvPlanes,
  type ClientePlanes,
  type PlanStryv,
  type RegresoCare,
  type StatusCare,
  type TonoCare
} from '../lib/stryvCareService';

/**
 * Planes STRYV (solo admin): STRYV Care (mantenimiento e infraestructura) y STRYV
 * Grow (videos con IA para redes). Cada tarjeta trae el estado de su suscripción,
 * próximo cobro, tarjeta, recibos y los botones que llevan a las páginas seguras
 * de Stripe. Mismo contenido y flujo que Fukuroll y Renovacell (EKKO-149): la
 * tarjeta se pone una sola vez y se cobra sola cada mes.
 */

const BADGE_POR_TONO: Record<TonoCare, string> = {
  success: 'ek-badge--success',
  warning: 'ek-badge--outline',
  danger: 'ek-badge--danger',
  neutral: 'ek-badge--neutral'
};

interface Props {
  /** Inyectable en pruebas; en la app es el servicio real. */
  cliente?: ClientePlanes;
}

export default function PlanesStryv({ cliente = stryvPlanes }: Props = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [regreso, setRegreso] = useState<{ tipo: RegresoCare; plan: PlanStryv } | null>(null);

  // Al volver de Stripe (?stryv=ok|cancel|volver&plan=care|grow) se lee una vez y se limpia la URL.
  useEffect(() => {
    const tipo = regresoDeStripe(searchParams.get('stryv'));
    if (!tipo) return;
    setRegreso({ tipo, plan: planDeRegreso(searchParams.get('plan')) ?? 'care' });
    const limpios = new URLSearchParams(searchParams);
    limpios.delete('stryv');
    limpios.delete('plan');
    setSearchParams(limpios, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div style={{ maxWidth: '640px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>OPERADO POR STRYV</p>
      <h1 className="ek-h2" style={{ marginBottom: '6px' }}>Planes STRYV</h1>
      <p className="ek-body-muted" style={{ marginBottom: '24px' }}>
        Tu sistema y tu contenido, operados por STRYV. Cada plan se activa por separado y se cobra solo cada mes.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {ORDEN_PLANES.map((plan) => (
          <TarjetaPlan key={plan} plan={plan} cliente={cliente} regreso={regreso?.plan === plan ? regreso.tipo : null} />
        ))}
      </div>

      <a className="ek-stryv-pill" href={STRYV_URL} target="_blank" rel="noopener noreferrer" style={{ marginTop: '16px' }}>
        <span className="ek-stryv-dot" aria-hidden="true" />
        Operado por <b>STRYV</b> · stryvstudio.com
      </a>
    </div>
  );
}

function TarjetaPlan({ plan, cliente, regreso }: { plan: PlanStryv; cliente: ClientePlanes; regreso: RegresoCare | null }) {
  const toast = useToast();
  const info = PLANES_STRYV[plan];
  const [d, setD] = useState<StatusCare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState<'checkout' | 'portal' | null>(null);

  const cargar = useCallback(async () => {
    const r = await cliente.estado(plan);
    if (r.ok) {
      setD(r.data);
      setError(null);
    } else {
      setError(r.message);
    }
  }, [cliente, plan]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function ir(accion: 'checkout' | 'portal') {
    setAbriendo(accion);
    const r = accion === 'checkout' ? await cliente.activar(plan) : await cliente.portal(plan);
    if (r.ok && r.data.url) {
      irA(r.data.url);
      return;
    }
    setAbriendo(null);
    toast.error(r.ok ? 'No pudimos abrir Stripe. Intenta de nuevo.' : r.message);
  }

  const estado = d ? ESTADO_CARE[d.estado] ?? { tono: 'neutral' as TonoCare, texto: String(d.estado) } : null;
  const disponible = !!d && d.estado !== 'no_disponible';
  const activo = disponible && d.estado !== 'inactivo';

  return (
    <section className="ek-card" data-testid={`plan-${plan}`} aria-label={info.nombre} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div className="care-brand">STRYV <span>{info.apellido}</span></div>
        {estado && disponible && (
          <span className={`ek-badge ${BADGE_POR_TONO[estado.tono]}`} data-testid={`${plan}-estado`}>{estado.texto}</span>
        )}
      </div>

      {regreso === 'ok' && (
        <div
          role="status"
          data-testid={`${plan}-regreso`}
          style={{ padding: '10px 14px', borderRadius: 'var(--ek-radius-sm)', background: 'var(--ek-success-soft)', color: 'var(--ek-success)', fontWeight: 600, fontSize: '13.5px' }}
        >
          {info.nombre} activado. ¡Gracias!
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: 'var(--ek-radius-sm)', background: 'var(--ek-danger-soft)', color: 'var(--ek-danger)', fontSize: '13.5px' }}
        >
          <span>No pudimos consultar {info.nombre}. {error}</span>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '36px', padding: '6px 12px' }} onClick={() => void cargar()}>
            Reintentar
          </button>
        </div>
      )}

      {!d && !error && <Spinner label="Cargando…" />}

      {d?.estado === 'no_disponible' && (
        <p className="ek-body-muted" style={{ margin: 0 }}>Aún no está disponible. STRYV te avisará cuando puedas activarlo.</p>
      )}

      {disponible && d && (
        <div className="care-precio">
          {pesosCare(d.monto_centavos)}
          <small> MXN al mes</small>
        </div>
      )}

      <p className="ek-body-muted" style={{ margin: 0, fontSize: '13.5px' }}>{info.descripcion}</p>

      <ul className="care-lista">
        {info.incluye.map((t) => (
          <li key={t}>
            <Check size={15} aria-hidden="true" /> {t}
          </li>
        ))}
      </ul>

      {d?.estado === 'inactivo' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
          <button type="button" className="ek-cta ek-cta--gold" onClick={() => void ir('checkout')} disabled={abriendo != null} data-testid={`${plan}-activar`}>
            {abriendo === 'checkout' ? <Spinner size={16} /> : <ShieldCheck size={16} aria-hidden="true" />}
            {abriendo === 'checkout' ? 'Abriendo Stripe…' : info.activar}
          </button>
          <p className="ek-helper-text" style={{ margin: 0 }}>
            Pones tu tarjeta una sola vez en la página segura de Stripe y se cobra automáticamente cada mes.
          </p>
        </div>
      )}

      {activo && d && (
        <>
          <div className="care-datos">
            <div>
              <span>{d.termina ? 'Termina el' : 'Próximo cobro'}</span>
              <b>{fechaCare(d.termina ?? d.proximo_cobro)}</b>
            </div>
            <div>
              <span>Tarjeta</span>
              <b>{d.tarjeta ? `${String(d.tarjeta.marca).toUpperCase()} ···· ${d.tarjeta.last4}` : '—'}</b>
            </div>
          </div>
          <div>
            <button type="button" className="ek-cta" onClick={() => void ir('portal')} disabled={abriendo != null} data-testid={`${plan}-portal`}>
              {abriendo === 'portal' ? 'Abriendo Stripe…' : 'Cambiar tarjeta o descargar recibos'}
            </button>
          </div>
          {d.recibos && d.recibos.length > 0 && (
            <div>
              <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: '0 0 4px' }}>RECIBOS</p>
              {d.recibos.map((r) => (
                <div key={`${r.fecha}-${r.monto_centavos}`} className="care-recibo">
                  <span>
                    {fechaCare(r.fecha)}
                    <small>{r.estado === 'paid' ? 'Pagado' : r.estado ?? ''}</small>
                  </span>
                  <span>
                    <b>{pesosCare(r.monto_centavos)}</b>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noopener noreferrer">
                        Ver <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
