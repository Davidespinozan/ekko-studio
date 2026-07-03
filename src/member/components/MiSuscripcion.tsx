import { useEffect, useState } from 'react';
import { Sparkles, Check, CreditCard, ArrowRight, X, AlertTriangle, Ticket, CalendarClock, Ban, RotateCcw } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { parseBeneficios, type Beneficio } from '@shared/lib/beneficios';
import { sufijoPrecio, detallePlan, esPlanPaquete } from '@shared/lib/planPresentacion';
import { obtenerBillingInfo, cancelarSuscripcion, type MetodoPago, type PagoHistorial } from '@shared/lib/checkout';
import { TarjetaModal } from '@shared/components/TarjetaModal';
import { PaymentModal } from '@shared/components/PaymentModal';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
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
  tipo: string;
  clases_incluidas: number | null;
  duracion_dias: number | null;
}

function formatearPesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

const STATUS_META: Record<string, { texto: string; clase: string }> = {
  activa: { texto: 'Activa', clase: 'ek-badge--success' },
  activo: { texto: 'Activa', clase: 'ek-badge--success' },
  active: { texto: 'Activa', clase: 'ek-badge--success' },
  pendiente_pago: { texto: 'Pendiente de pago', clase: 'ek-badge--outline' },
  suspendida: { texto: 'Suspendida', clase: 'ek-badge--danger' },
  suspendido: { texto: 'Suspendida', clase: 'ek-badge--danger' },
  cancelada: { texto: 'Cancelada', clase: 'ek-badge--danger' },
  cancelado: { texto: 'Cancelada', clase: 'ek-badge--danger' }
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
  const [pagos, setPagos] = useState<PagoHistorial[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<MetodoPago | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingError, setBillingError] = useState(false);
  const [membresia, setMembresia] = useState<MembresiaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [cambiarOpen, setCambiarOpen] = useState(false);
  const currentSlug = tierSlug;
  const [gestionando, setGestionando] = useState(false);
  const [pagarTier, setPagarTier] = useState<TierInfo | null>(null);
  const [tarjetaOpen, setTarjetaOpen] = useState(false);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);
  // Destino de un cambio créditos→mensual que perdería el saldo (aviso).
  const [confirmarCambio, setConfirmarCambio] = useState<TierInfo | null>(null);

  // Recarga tarjeta + historial tras un cambio (nueva tarjeta guardada).
  async function recargarBilling() {
    try {
      const info = await obtenerBillingInfo();
      setPaymentMethod(info.paymentMethod);
      setPagos(info.pagos ?? []);
    } catch {
      /* la sección muestra su estado */
    }
  }

  useEffect(() => {
    let mounted = true;
    async function load() {
      const [tiersRes, memRes] = await Promise.all([
        supabase
          .from('tiers')
          .select('slug, nombre, precio_centavos, beneficios, descripcion, tipo, clases_incluidas, duracion_dias')
          .eq('tenant_id', tenant.id)
          .eq('activo', true)
          .order('precio_centavos', { ascending: true }),
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
          descripcion: t.descripcion,
          tipo: t.tipo,
          clases_incluidas: t.clases_incluidas,
          duracion_dias: t.duracion_dias
        }))
      );
      setMembresia(((memRes.data ?? [])[0] as MembresiaInfo | undefined) ?? null);
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, usuarioId]);

  // Tarjeta + historial vienen de Stripe (cuenta conectada) vía backend: los
  // miembros NO pueden leer payment_events (RLS admin-only).
  useEffect(() => {
    let mounted = true;
    (async () => {
      setBillingLoading(true);
      setBillingError(false);
      try {
        const info = await obtenerBillingInfo();
        if (!mounted) return;
        setPaymentMethod(info.paymentMethod);
        setPagos(info.pagos ?? []);
      } catch (e) {
        if (!mounted) return;
        console.error('[MiSuscripcion] billing-info', e);
        setBillingError(true);
      } finally {
        if (mounted) setBillingLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [usuarioId]);

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

  // Abre el modal de pago propio (Elements) para el plan elegido.
  function cambiarPlan(destino: TierInfo) {
    // Aviso: pasar de un paquete con créditos restantes a un plan mensual
    // (ilimitado) descarta el saldo. Que sea una elección consciente.
    const saldo = membresia?.creditos_restantes ?? 0;
    if (saldo > 0 && !esPlanPaquete(destino)) {
      setConfirmarCambio(destino);
      return;
    }
    setCambiarOpen(false);
    setPagarTier(destino);
  }

  function procederCambio(destino: TierInfo) {
    setConfirmarCambio(null);
    setCambiarOpen(false);
    setPagarTier(destino);
  }

  async function togglenCancelacion(reactivar: boolean) {
    setGestionando(true);
    try {
      const res = await cancelarSuscripcion(reactivar);
      setMembresia((prev) => (prev ? { ...prev, cancel_at_period_end: res.cancel_at_period_end } : prev));
      setConfirmarCancelar(false);
      toast.success(
        reactivar
          ? '¡Listo! Tu plan se renovará normalmente.'
          : 'Tu plan se cancelará al final del periodo. Puedes reactivarlo cuando quieras.'
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos actualizar tu suscripción. Intenta de nuevo.');
    } finally {
      setGestionando(false);
    }
  }

  return (
    <section>

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
                  Actualiza tu método de pago para no perder el acceso al estudio.
                </p>
                <button
                  type="button"
                  className="ek-cta ek-cta--gold"
                  style={{ padding: '9px 16px', fontSize: '13px' }}
                  onClick={() => setTarjetaOpen(true)}
                >
                  Actualizar tarjeta
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
            </div>

            {planActual ? (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '14px' }}>
                <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '34px', fontWeight: 700, margin: 0, letterSpacing: '-0.03em' }}>
                  {formatearPesos(planActual.precio_centavos)}
                  <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>{sufijoPrecio(planActual)}</span>
                </p>
                <span className={`ek-badge ${statusMeta.clase}`}>{statusMeta.texto}</span>
              </div>
            ) : (
              // Sin plan: NO mostrar "activo"/renovación/cancelar (eso es de una
              // suscripción). Solo un aviso + el CTA para elegir uno.
              <p className="ek-body-muted" style={{ margin: '0 0 16px' }}>
                No tienes un plan activo. Elige uno para empezar a reservar.
              </p>
            )}
            {planActual && (
              <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '-8px 0 14px' }}>
                {detallePlan(planActual)}
              </p>
            )}

            {/* Saldo de créditos (solo planes por paquete) */}
            {planActual && creditos !== null && (
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
                    {creditos > 0 ? 'Se descuenta 1 por reserva.' : 'Compra un paquete para seguir reservando.'}
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

            {/* Renovación / vencimiento del plan */}
            {planActual && finPeriodo && (
              cancelaAlFin ? (
                <p className="ek-helper-text" style={{ marginTop: 0, marginBottom: '12px', color: 'var(--ek-warning)' }}>
                  Tu plan se cancela el {finPeriodo}. Puedes reactivarlo aquí abajo.
                </p>
              ) : (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px 14px', marginBottom: '14px',
                  borderRadius: 'var(--ek-r-md)', background: 'var(--ek-bg-soft)',
                  border: '0.5px solid var(--ek-line)'
                }}>
                  <CalendarClock size={16} style={{ color: 'var(--ek-mustard)', flexShrink: 0 }} aria-hidden="true" />
                  <p style={{ margin: 0, fontSize: '13px' }}>
                    {creditos !== null ? 'Tu paquete vence el ' : tieneSuscripcion ? 'Se renueva el ' : 'Vigente hasta el '}
                    <strong>{finPeriodo}</strong>
                  </p>
                </div>
              )
            )}

            <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => setCambiarOpen(true)}>
              {planActual ? 'Cambiar de plan' : 'Ver planes'} <ArrowRight size={16} aria-hidden="true" />
            </button>

            {/* Cancelar / reactivar — todo in-app, sin salir a Stripe */}
            {planActual && tieneSuscripcion && (
              cancelaAlFin ? (
                <button
                  type="button"
                  className="ek-cta ek-cta--secondary ek-cta--full"
                  style={{ marginTop: '10px' }}
                  onClick={() => void togglenCancelacion(true)}
                  disabled={gestionando}
                >
                  {gestionando ? <Spinner size={15} /> : <>Reactivar plan <RotateCcw size={15} aria-hidden="true" /></>}
                </button>
              ) : (
                <button
                  type="button"
                  className="ek-cta ek-cta--secondary ek-cta--full"
                  style={{ marginTop: '10px' }}
                  onClick={() => setConfirmarCancelar(true)}
                  disabled={gestionando}
                >
                  Cancelar plan <Ban size={15} aria-hidden="true" />
                </button>
              )
            )}
          </div>

          {/* Método de pago */}
          <div className="ek-card" style={{ marginBottom: '16px' }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>MÉTODO DE PAGO</p>
            {billingLoading ? (
              <div className="ek-skeleton" style={{ height: '54px', borderRadius: 'var(--ek-r-md)' }} />
            ) : billingError ? (
              <p className="ek-body-muted" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={16} style={{ color: 'var(--ek-warning)' }} aria-hidden="true" />
                No pudimos cargar tu método de pago. Recargá la página.
              </p>
            ) : paymentMethod ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{
                  minWidth: 46, height: 32, borderRadius: '7px',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--ek-bg-elevated)', border: '0.5px solid var(--ek-line-strong)',
                  fontSize: '10px', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase'
                }}>
                  {paymentMethod.brand}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>
                    {paymentMethod.brand.charAt(0).toUpperCase() + paymentMethod.brand.slice(1)} ···· {paymentMethod.last4}
                  </p>
                  <p className="ek-body-faint" style={{ margin: 0 }}>
                    Vence {String(paymentMethod.expMonth).padStart(2, '0')}/{String(paymentMethod.expYear).slice(-2)}
                  </p>
                </div>
                <button
                  type="button"
                  className="ek-cta ek-cta--secondary"
                  style={{ padding: '9px 14px', fontSize: '12px' }}
                  onClick={() => setTarjetaOpen(true)}
                >
                  Actualizar
                </button>
              </div>
            ) : (
              <EmptyState
                icon={CreditCard}
                tone="neutral"
                title="Sin tarjeta registrada"
                hint="Guarda una tarjeta para pagar y renovar sin salir de la app."
                action={
                  <button type="button" className="ek-cta ek-cta--gold" onClick={() => setTarjetaOpen(true)}>
                    Agregar tarjeta <CreditCard size={15} aria-hidden="true" />
                  </button>
                }
              />
            )}
          </div>

          {/* Historial de cobros */}
          <div className="ek-card">
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>HISTORIAL DE PAGOS</p>
            {billingLoading ? (
              <div className="ek-skeleton" style={{ height: '48px', borderRadius: 'var(--ek-r-md)' }} />
            ) : billingError ? (
              <p className="ek-body-muted" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={16} style={{ color: 'var(--ek-warning)' }} aria-hidden="true" />
                No pudimos cargar tu historial. Recargá la página.
              </p>
            ) : pagos.length === 0 ? (
              <EmptyState
                icon={CreditCard}
                tone="neutral"
                title="Sin pagos todavía"
                hint="Tus cobros aparecerán aquí después de tu primer pago."
              />
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {pagos.map((p) => (
                  <li key={p.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    paddingBottom: '10px', borderBottom: '0.5px solid var(--ek-line)'
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>
                        {formatearPesos(p.monto_centavos)}
                        <span style={{ color: 'var(--ek-ink-muted)', fontWeight: 500 }}> {p.moneda.toUpperCase()}</span>
                      </p>
                      <p className="ek-body-faint" style={{ margin: 0 }}>
                        {new Date(p.fecha).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    </div>
                    <span className={`ek-badge ${p.status === 'succeeded' ? 'ek-badge--success' : p.status === 'pending' ? 'ek-badge--outline' : 'ek-badge--danger'}`}>
                      {p.status === 'succeeded' ? 'Pagado' : p.status === 'pending' ? 'Pendiente' : 'Falló'}
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
              Elige tu nuevo plan. Pagas de forma segura sin salir de la app.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {tiers.map((t) => {
                const esActual = t.slug === tierSlug;
                return (
                  <div key={t.slug} className="ek-card ek-card--md ek-card--cream" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(10, 10, 10, 0.6)' }}>
                          {t.nombre}
                        </span>
                        {esActual && (
                          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ek-bg)', background: 'rgba(10, 10, 10, 0.1)', padding: '2px 8px', borderRadius: '999px' }}>
                            Actual
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontWeight: 700, color: 'var(--ek-bg)' }}>
                        {formatearPesos(t.precio_centavos)}<span style={{ color: 'rgba(10, 10, 10, 0.55)', fontWeight: 500, fontSize: '13px' }}>{sufijoPrecio(t)}</span>
                      </p>
                      <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'rgba(10, 10, 10, 0.55)' }}>{detallePlan(t)}</p>
                    </div>
                    {!esActual && (
                      <button
                        type="button"
                        className="ek-cta ek-cta--gold"
                        style={{ padding: '10px 14px', fontSize: '13px', whiteSpace: 'nowrap', flexShrink: 0, gap: '6px' }}
                        onClick={() => cambiarPlan(t)}
                      >
                        Elegir este <ArrowRight size={15} aria-hidden="true" />
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

      {/* Pago in-app (modal propio de EKKO con Stripe Elements) */}
      {pagarTier && (
        <PaymentModal
          tierSlug={pagarTier.slug}
          tierNombre={pagarTier.nombre}
          precio={Math.round(pagarTier.precio_centavos / 100)}
          esPaquete={pagarTier.tipo === 'creditos' || pagarTier.tipo === 'hibrido'}
          onClose={() => setPagarTier(null)}
          onPagado={() => {
            setPagarTier(null);
            toast.success('¡Pago recibido! Tu plan se está activando, puede tardar unos segundos.');
          }}
        />
      )}

      {/* Actualizar tarjeta in-app (SetupIntent + Elements) */}
      {tarjetaOpen && (
        <TarjetaModal
          onClose={() => setTarjetaOpen(false)}
          onGuardada={() => {
            setTarjetaOpen(false);
            toast.success('¡Tarjeta actualizada!');
            void recargarBilling();
          }}
        />
      )}

      {/* Confirmación de cancelación */}
      {confirmarCancelar && (
        <div className="ek-backdrop" onClick={() => !gestionando && setConfirmarCancelar(false)} role="dialog" aria-modal="true">
          <div className="ek-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>CANCELAR PLAN</p>
            <h3 className="ek-display-md" style={{ margin: '0 0 8px' }}>¿Seguro que quieres cancelar?</h3>
            <p className="ek-body-muted" style={{ marginTop: 0, marginBottom: '18px' }}>
              Mantienes el acceso {finPeriodo ? `hasta el ${finPeriodo}` : 'hasta el final del periodo'}. No se te vuelve a cobrar y puedes reactivarlo cuando quieras.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={() => setConfirmarCancelar(false)} disabled={gestionando}>
                Mantener plan
              </button>
              <button type="button" className="ek-cta ek-cta--danger ek-cta--full" onClick={() => void togglenCancelacion(false)} disabled={gestionando}>
                {gestionando ? <Spinner size={15} /> : 'Sí, cancelar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmarCambio && (
        <div className="ek-backdrop" onClick={() => setConfirmarCambio(null)} role="dialog" aria-modal="true">
          <div className="ek-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}>
            <p className="ek-eyebrow" style={{ color: 'var(--ek-warning)', marginBottom: '8px' }}>
              <AlertTriangle size={12} aria-hidden="true" /> PIERDES TUS CRÉDITOS
            </p>
            <h3 className="ek-display-md" style={{ margin: '0 0 8px' }}>
              Te quedan {creditos} {creditos === 1 ? 'crédito' : 'créditos'}
            </h3>
            <p className="ek-body-muted" style={{ marginTop: 0, marginBottom: '18px' }}>
              El plan <strong>{confirmarCambio.nombre}</strong> es mensual (acceso ilimitado), así que
              tu saldo de créditos <strong>se perderá</strong>. Si quieres aprovecharlos, úsalos antes de cambiar.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="ek-cta ek-cta--secondary ek-cta--full" onClick={() => setConfirmarCambio(null)}>
                Mejor no
              </button>
              <button type="button" className="ek-cta ek-cta--full" onClick={() => procederCambio(confirmarCambio)}>
                Continuar igual
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
