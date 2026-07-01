import { useEffect, useState } from 'react';
import { Sparkles, Check, CreditCard, ArrowRight, X, AlertTriangle, Settings, Ticket } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { parseBeneficios, type Beneficio } from '@shared/lib/beneficios';
import { iniciarCheckout, abrirPortal } from '@shared/lib/checkout';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { TierBadge } from '@shared/components/TierBadge';
import { EmptyState } from '@shared/components/EmptyState';
import { Spinner } from '@shared/components/Spinner';

interface MembresiaInfo {
  status: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean | null;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
}

interface TierInfo {
  slug: string;
  nombre: string;
  precio_centavos: number;
  beneficios: Beneficio[];
  descripcion: string | null;
}

interface PagoInfo {
  id: string;
  monto_centavos: number | null;
  moneda: string | null;
  status: string | null;
  created_at: string;
}

function formatearPesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

const STATUS_META: Record<string, { texto: string; clase: string }> = {
  activa: { texto: 'Activa', clase: 'ek-badge--success' },
  active: { texto: 'Activa', clase: 'ek-badge--success' },
  pendiente_pago: { texto: 'Pendiente de pago', clase: 'ek-badge--outline' },
  suspendida: { texto: 'Suspendida', clase: 'ek-badge--danger' },
  cancelada: { texto: 'Cancelada', clase: 'ek-badge--danger' }
};

interface Props {
  usuarioId: string;
  tierSlug: string | null;
  status: string | null | undefined;
}

export function MiSuscripcion({ usuarioId, tierSlug, status }: Props) {
  const tenant = useTenant();
  const toast = useToast();
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [pagos, setPagos] = useState<PagoInfo[]>([]);
  const [membresia, setMembresia] = useState<MembresiaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [cambiarOpen, setCambiarOpen] = useState(false);
  const [currentSlug, setCurrentSlug] = useState<string | null>(tierSlug);
  const [cambiando, setCambiando] = useState<string | null>(null);
  const [gestionando, setGestionando] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [tiersRes, pagosRes, memRes] = await Promise.all([
        supabase
          .from('tiers')
          .select('slug, nombre, precio_centavos, beneficios, descripcion')
          .eq('tenant_id', tenant.id)
          .eq('activo', true)
          .order('precio_centavos', { ascending: true }),
        supabase
          .from('payment_events')
          .select('id, monto_centavos, moneda, status, created_at')
          .eq('usuario_id', usuarioId)
          .order('created_at', { ascending: false })
          .limit(12),
        supabase
          .from('membresias')
          .select('status, stripe_subscription_id, cancel_at_period_end, periodo_actual_fin, creditos_restantes')
          .eq('usuario_id', usuarioId)
          .order('created_at', { ascending: false })
          .limit(1)
      ]);
      if (!mounted) return;
      setTiers(
        (tiersRes.data ?? []).map((t) => ({
          slug: t.slug,
          nombre: t.nombre,
          precio_centavos: t.precio_centavos,
          beneficios: parseBeneficios(t.beneficios),
          descripcion: t.descripcion
        }))
      );
      setPagos((pagosRes.data ?? []) as PagoInfo[]);
      setMembresia(((memRes.data ?? [])[0] as MembresiaInfo | undefined) ?? null);
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, usuarioId]);

  // Retorno desde el Checkout de Stripe (?suscripcion=ok|cancelado).
  useEffect(() => {
    const estado = new URLSearchParams(window.location.search).get('suscripcion');
    if (estado === 'ok') {
      toast.success('¡Listo! Tu suscripción se está activando, puede tardar unos segundos.');
    } else if (estado === 'cancelado') {
      toast.info('Cancelaste el checkout. Tu plan no cambió.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const planActual = tiers.find((t) => t.slug === currentSlug) ?? null;
  const statusMeta = STATUS_META[status ?? ''] ?? { texto: status ?? '—', clase: 'ek-badge--neutral' };
  const tieneSuscripcion = !!membresia?.stripe_subscription_id;
  const creditos = membresia?.creditos_restantes ?? null; // null = plan mensual (ilimitado)
  const pagoVencido = membresia?.status === 'past_due';
  const cancelaAlFin = membresia?.cancel_at_period_end === true;
  const finPeriodo = membresia?.periodo_actual_fin
    ? new Date(membresia.periodo_actual_fin).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  async function cambiarPlan(destino: TierInfo) {
    setCambiando(destino.slug);
    try {
      const res = await iniciarCheckout(destino.slug);
      if (res.url) return; // iniciarCheckout ya redirige al Checkout de Stripe
      if (res.reason === 'stripe_pendiente') {
        setCambiarOpen(false);
        toast.info('Acercate a recepción para activar tu nuevo plan, o escribinos por WhatsApp.');
      } else if (res.activated) {
        setCurrentSlug(destino.slug);
        setCambiarOpen(false);
        toast.success(`Tu plan ahora es ${destino.nombre}.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos iniciar el cambio. Intentá de nuevo.');
    } finally {
      setCambiando(null);
    }
  }

  async function gestionarSuscripcion() {
    setGestionando(true);
    try {
      const res = await abrirPortal();
      if (res.url) return; // abrirPortal ya redirige al Customer Portal
      if (res.reason === 'stripe_pendiente') {
        toast.info('La gestión en línea estará disponible cuando el estudio active los pagos.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos abrir la gestión. Intentá de nuevo.');
    } finally {
      setGestionando(false);
    }
  }

  return (
    <section>
      <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '14px' }}>
        MI SUSCRIPCIÓN
      </p>

      {loading ? (
        <div className="ek-card"><Spinner size={18} label="Cargando tu plan…" /></div>
      ) : (
        <>
          {/* Aviso de pago vencido (past_due): mantiene acceso, pide actualizar tarjeta */}
          {pagoVencido && (
            <div
              role="alert"
              className="ek-card"
              style={{
                marginBottom: '16px',
                borderColor: 'var(--ek-warning)',
                background: 'var(--ek-warning-soft)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <AlertTriangle size={18} style={{ color: 'var(--ek-warning)', flexShrink: 0, marginTop: '1px' }} aria-hidden="true" />
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>Tu último pago no se procesó</p>
                <p className="ek-body-muted" style={{ margin: '4px 0 10px' }}>
                  Actualizá tu método de pago para no perder el acceso al estudio.
                </p>
                <button
                  type="button"
                  className="ek-cta"
                  style={{ padding: '9px 16px', fontSize: '13px' }}
                  onClick={gestionarSuscripcion}
                  disabled={gestionando}
                >
                  {gestionando ? <Spinner size={15} /> : 'Actualizar pago'}
                </button>
              </div>
            </div>
          )}

          {/* Plan actual */}
          <div className="ek-card--hero" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="ek-empty-icon" style={{ width: 48, height: 48, margin: 0 }}>
                  <Sparkles size={22} aria-hidden="true" />
                </span>
                <div>
                  <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>PLAN ACTUAL</p>
                  <h3 style={{
                    fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700,
                    margin: 0, letterSpacing: '-0.02em'
                  }}>
                    {planActual?.nombre ?? (tierSlug ?? 'Sin plan')}
                  </h3>
                </div>
              </div>
              {planActual && <TierBadge pro={planActual.slug === 'pro'} />}
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' }}>
              {planActual && (
                <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '34px', fontWeight: 700, margin: 0, letterSpacing: '-0.03em' }}>
                  {formatearPesos(planActual.precio_centavos)}
                  <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span>
                </p>
              )}
              <span className={`ek-badge ${statusMeta.clase}`}>{statusMeta.texto}</span>
            </div>

            {/* Saldo de créditos (solo planes por paquete) */}
            {creditos !== null && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '12px 14px',
                  marginBottom: '16px',
                  borderRadius: 'var(--ek-r-md)',
                  background: creditos > 0 ? 'var(--ek-mustard-soft)' : 'var(--ek-warning-soft)',
                  border: `0.5px solid ${creditos > 0 ? 'var(--ek-mustard-dim)' : 'var(--ek-warning)'}`
                }}
              >
                <Ticket size={20} style={{ color: 'var(--ek-mustard)', flexShrink: 0 }} aria-hidden="true" />
                <div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: '18px', fontFamily: 'var(--ek-font-display)', letterSpacing: '-0.02em' }}>
                    {creditos} {creditos === 1 ? 'sesión' : 'sesiones'} disponibles
                  </p>
                  <p className="ek-body-muted" style={{ margin: 0, fontSize: '12px' }}>
                    {creditos > 0 ? 'Se descuenta 1 por reserva.' : 'Comprá un paquete para seguir reservando.'}
                  </p>
                </div>
              </div>
            )}

            {planActual && planActual.beneficios.filter((b) => b.incluido).length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 18px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {planActual.beneficios.filter((b) => b.incluido).map((b, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                    <Check size={15} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                    {b.label}
                  </li>
                ))}
              </ul>
            )}

            {cancelaAlFin && (
              <p className="ek-helper-text" style={{ marginTop: 0, marginBottom: '12px', color: 'var(--ek-warning)' }}>
                Tu plan se cancela{finPeriodo ? ` el ${finPeriodo}` : ' al terminar el período'}. Podés reactivarlo desde “Gestionar suscripción”.
              </p>
            )}

            <button type="button" className="ek-cta ek-cta--full" onClick={() => setCambiarOpen(true)}>
              Cambiar de plan <ArrowRight size={16} aria-hidden="true" />
            </button>

            {tieneSuscripcion && (
              <button
                type="button"
                className="ek-cta ek-cta--secondary ek-cta--full"
                style={{ marginTop: '10px' }}
                onClick={gestionarSuscripcion}
                disabled={gestionando}
              >
                {gestionando ? <Spinner size={15} /> : <>Gestionar suscripción <Settings size={15} aria-hidden="true" /></>}
              </button>
            )}
          </div>

          {/* Método de pago e historial */}
          <div className="ek-card">
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>PAGOS</p>
            {pagos.length === 0 ? (
              <EmptyState
                icon={CreditCard}
                tone="neutral"
                title="Sin pagos registrados"
                hint="Tu método de pago y el historial de cobros aparecerán aquí cuando el estudio active la pasarela de pago."
              />
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {pagos.map((p) => (
                  <li key={p.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    paddingBottom: '10px', borderBottom: '0.5px solid var(--ek-line)'
                  }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>
                        {p.monto_centavos != null ? formatearPesos(p.monto_centavos) : '—'}
                        {p.moneda ? ` ${p.moneda.toUpperCase()}` : ''}
                      </p>
                      <p className="ek-body-faint" style={{ margin: 0 }}>
                        {new Date(p.created_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    </div>
                    <span className={`ek-badge ${p.status === 'succeeded' || p.status === 'paid' ? 'ek-badge--success' : 'ek-badge--neutral'}`}>
                      {p.status ?? '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* Modal cambiar de plan */}
      {cambiarOpen && (
        <div className="ek-backdrop" onClick={() => setCambiarOpen(false)} role="dialog" aria-modal="true">
          <div
            className="ek-card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '440px', width: '100%', maxHeight: '88vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <p className="ek-eyebrow ek-eyebrow--mustard">CAMBIAR DE PLAN</p>
              <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={() => setCambiarOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="ek-body-muted" style={{ marginTop: 0, marginBottom: '18px' }}>
              Elegí tu nuevo plan. Te llevamos al pago seguro de Stripe.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {tiers.map((t) => {
                const esActual = t.slug === tierSlug;
                return (
                  <div key={t.slug} className="ek-card ek-card--md" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <TierBadge pro={t.slug === 'pro'} />
                        {esActual && <span className="ek-badge ek-badge--neutral">Actual</span>}
                      </div>
                      <p style={{ margin: 0, fontWeight: 600 }}>
                        {formatearPesos(t.precio_centavos)}<span style={{ color: 'var(--ek-ink-muted)', fontWeight: 500, fontSize: '13px' }}>/mes</span>
                      </p>
                    </div>
                    {!esActual && (
                      <button
                        type="button"
                        className="ek-cta"
                        style={{ padding: '10px 16px', fontSize: '13px' }}
                        onClick={() => cambiarPlan(t)}
                        disabled={cambiando !== null}
                      >
                        {cambiando === t.slug
                          ? <Spinner size={15} />
                          : <>Elegir este <ArrowRight size={15} aria-hidden="true" /></>}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="ek-helper-text" style={{ marginTop: '14px' }}>
              El cobro lo procesa Stripe de forma segura. El cobro proporcional se ajusta en tu próximo período.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
