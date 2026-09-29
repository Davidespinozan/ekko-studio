import { useEffect, useState } from 'react';
import { Sparkles, Check, CreditCard, ArrowRight, X, AlertTriangle, Ticket, CalendarClock, Ban, RotateCcw } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { parseBeneficios, type Beneficio } from '@shared/lib/beneficios';
import { sufijoPrecio, detallePlan, esPlanPaquete } from '@shared/lib/planPresentacion';
import { obtenerBillingInfo, cancelarSuscripcion, cambiarPlanSuscripcion, type MetodoPago, type PagoHistorial } from '@shared/lib/checkout';
import { TarjetaModal } from '@shared/components/TarjetaModal';
import { PaymentModal } from '@shared/components/PaymentModal';
import { PlanTipoToggle, type VistaPlan } from '@shared/components/PlanTipoToggle';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { useAuth } from '@shared/hooks/useAuth';
import { EmptyState } from '@shared/components/EmptyState';
import { Spinner } from '@shared/components/Spinner';
import { ErrorCarga, ErrorInline } from '@shared/components/ErrorCarga';
import { observarActivacion } from '@shared/lib/observarActivacion';
import {
  guardarPagoPendiente,
  leerPagoPendiente,
  leerRetornoPago,
  limpiarPagoPendiente,
  mensajePagoPendiente,
  MENSAJE_PAGO,
  type PagoPendiente
} from '@shared/lib/pagoEstado';

interface MembresiaInfo {
  status: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean | null;
  periodo_actual_fin: string | null;
  creditos_restantes: number | null;
  created_at?: string | null;
  /** Plan REAL de la membresía (PKG-02B · C28): "Actual" se deriva de aquí, no de usuarios.membresia_tier. */
  tier?: { slug: string; tipo: string | null } | null;
}

const ESTADOS_VIVOS = ['trialing', 'activa', 'past_due', 'pausada'];
const SELECT_MEMBRESIA = 'status, stripe_subscription_id, cancel_at_period_end, periodo_actual_fin, creditos_restantes, created_at, tier:tiers(slug, tipo)';

/** Estado de la activación tras un pago (PKG-02B · C04): nunca se afirma "activo" sin observarlo. */
type Activacion =
  | { estado: 'observando' | 'no_observada' | 'error'; slug: string | null; desde: number }
  | { estado: 'en_proceso' | 'desconocido'; slug: string | null; desde: number };

interface TierInfo {
  slug: string;
  nombre: string;
  precio_centavos: number;
  beneficios: Beneficio[];
  descripcion: string | null;
  tipo: string;
  clases_incluidas: number | null;
  duracion_dias: number | null;
  /** Se puede COMPRAR hoy (activo y en venta). El plan actual puede no serlo. */
  vendible: boolean;
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
  const { refreshUsuario } = useAuth();
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [pagos, setPagos] = useState<PagoHistorial[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<MetodoPago | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingError, setBillingError] = useState(false);
  const [membresia, setMembresia] = useState<MembresiaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // PKG-02A (C02 · F16): fallo leyendo plan/membresía ≠ "No tienes un plan activo".
  const [errorCarga, setErrorCarga] = useState(false);
  const [intentoCarga, setIntentoCarga] = useState(0);
  const [cambiarOpen, setCambiarOpen] = useState(false);
  const [vistaPlan, setVistaPlan] = useState<VistaPlan>('membresias');
  const currentSlug = tierSlug;
  const [gestionando, setGestionando] = useState(false);
  const [pagarTier, setPagarTier] = useState<TierInfo | null>(null);
  // slug del plan en proceso de swap (cambio in-place con tarjeta guardada).
  const [swapping, setSwapping] = useState<string | null>(null);
  const [tarjetaOpen, setTarjetaOpen] = useState(false);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);
  // Destino de un cambio créditos→mensual que perdería el saldo (aviso).
  const [confirmarCambio, setConfirmarCambio] = useState<TierInfo | null>(null);

  // PKG-02B (C04): PAGO CONFIRMADO ≠ PLAN ACTIVO. Se observa (solo lectura) la
  // membresía hasta ver la evidencia ESPERADA: una membresía viva del plan pagado
  // creada después del pago (activar_membresia crea una fila nueva; recomprar un
  // paquete también). Antes bastaba "algo cambió", que se disparaba con una
  // pausa, una cancelación o un `null` por error de red ("No tienes un plan").
  const [activacion, setActivacion] = useState<Activacion | null>(null);
  const [retornoFallido, setRetornoFallido] = useState(false);

  async function observarActivacionPlan(slugEsperado: string | null, desde: number) {
    setActivacion({ estado: 'observando', slug: slugEsperado, desde });
    const obs = await observarActivacion<MembresiaInfo>({
      leer: async () => {
        const { data, error } = await supabase
          .from('membresias')
          .select(SELECT_MEMBRESIA)
          .eq('usuario_id', usuarioId)
          .in('status', ESTADOS_VIVOS)
          .order('created_at', { ascending: false })
          .limit(1);
        return { data: ((data ?? [])[0] as unknown as MembresiaInfo | undefined) ?? null, error };
      },
      listo: (m) =>
        (slugEsperado ? m.tier?.slug === slugEsperado : true) &&
        !!m.created_at && new Date(m.created_at).getTime() >= desde - 60_000
    });
    if (obs.resultado === 'observada') {
      setMembresia(obs.dato);
      setActivacion(null);
      limpiarPagoPendiente();
      toast.success('Tu plan ya está activo.');
      await Promise.all([refreshUsuario(), recargarBilling()]);
      return;
    }
    setActivacion({ estado: obs.resultado === 'error' ? 'error' : 'no_observada', slug: slugEsperado, desde });
  }

  /** Pago confirmado (Stripe: succeeded) → registrar el pendiente y observar la activación. */
  function pagoConfirmado(paymentIntentId: string | null, slug: string | null) {
    const p = guardarPagoPendiente({ flujo: 'perfil', paymentIntentId, estado: 'confirmado', ...(slug ? { contexto: { slug } } : {}) });
    void observarActivacionPlan(slug, p.ts);
  }

  function pagoNoResuelto(p: PagoPendiente) {
    setActivacion({ estado: p.estado === 'en_proceso' ? 'en_proceso' : 'desconocido', slug: (p.contexto?.slug as string | undefined) ?? null, desde: p.ts });
  }

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
      setLoading(true);
      setErrorCarga(false);
      const [tiersRes, memRes] = await Promise.all([
        supabase
          .from('tiers')
          // SIN filtrar por activo/en_venta: el plan ACTUAL del miembro puede estar
          // retirado de la venta o archivado, y aun así es SU plan. Antes se
          // filtraba aquí, `planActual` quedaba en null y un suscriptor de un plan
          // retirado veía "No tienes un plan activo"… sin botón de Cancelar,
          // mientras se le seguía cobrando. Lo que se ofrece a la venta se filtra
          // abajo con `vendible`.
          .select('slug, nombre, precio_centavos, beneficios, descripcion, tipo, clases_incluidas, duracion_dias, activo, en_venta')
          .eq('tenant_id', tenant.id)
          // Mismo orden que el registro (PagarMembresia): mensuales primero,
          // luego paquetes. `orden` agrupa por modelo; precio desempata.
          .order('orden', { ascending: true })
          .order('precio_centavos', { ascending: true }),
        supabase
          .from('membresias')
          .select(SELECT_MEMBRESIA)
          .eq('usuario_id', usuarioId)
          .order('created_at', { ascending: false })
          .limit(1)
      ]);
      if (!mounted) return;
      if (tiersRes.error || memRes.error) {
        console.error('[MiSuscripcion]', tiersRes.error ?? memRes.error);
        setErrorCarga(true); // no se afirma "sin plan" ni se ofrece nada con datos desconocidos
        setLoading(false);
        return;
      }
      setTiers(
        (tiersRes.data ?? []).map((t) => ({
          slug: t.slug,
          nombre: t.nombre,
          precio_centavos: t.precio_centavos,
          beneficios: parseBeneficios(t.beneficios),
          descripcion: t.descripcion,
          tipo: t.tipo,
          clases_incluidas: t.clases_incluidas,
          duracion_dias: t.duracion_dias,
          vendible: t.activo === true && t.en_venta !== false
        }))
      );
      setMembresia(((memRes.data ?? [])[0] as unknown as MembresiaInfo | undefined) ?? null);
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, usuarioId, intentoCarga]);

  // Tarjeta + historial vienen de Stripe (cuenta conectada) vía backend: los
  // miembros NO pueden leer payment_events (RLS admin-only).
  useEffect(() => {
    let mounted = true;
    (async () => {
      setBillingLoading(true);
      setBillingError(false);
      // Reintenta: la 1ª llamada tras inactividad puede caer por cold start de la
      // Netlify Function → no mostramos error hasta agotar los reintentos.
      const intentos = 3;
      for (let i = 0; i < intentos && mounted; i++) {
        try {
          const info = await obtenerBillingInfo();
          if (!mounted) return;
          setPaymentMethod(info.paymentMethod);
          setPagos(info.pagos ?? []);
          setBillingLoading(false);
          return;
        } catch (e) {
          if (i < intentos - 1) {
            await new Promise((r) => setTimeout(r, 800 * (i + 1)));
            continue;
          }
          if (!mounted) return;
          console.error('[MiSuscripcion] billing-info', e);
          setBillingError(true);
          setBillingLoading(false);
        }
      }
    })();
    return () => { mounted = false; };
  }, [usuarioId]);

  // PKG-02B: retorno de un método con redirección (?pago=perfil&redirect_status=…),
  // retorno del Checkout (?suscripcion=ok|cancelado) y pago no resuelto persistido.
  // Nada de esto AFIRMA activación: se observa la evidencia.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = leerRetornoPago(window.location.search);
    const pendiente = leerPagoPendiente('perfil');
    const slugPendiente = (pendiente?.contexto?.slug as string | undefined) ?? null;
    if (r.flujo === 'perfil' && r.estado !== null) {
      if (r.estado === 'succeeded') pagoConfirmado(r.paymentIntentId, slugPendiente);
      else if (r.estado === 'processing') pagoNoResuelto(guardarPagoPendiente({ flujo: 'perfil', paymentIntentId: r.paymentIntentId, estado: 'en_proceso' }));
      else if (r.estado === 'desconocido') pagoNoResuelto(guardarPagoPendiente({ flujo: 'perfil', paymentIntentId: r.paymentIntentId, estado: 'desconocido' }));
      else setRetornoFallido(true); // failed: no se afirma cargo
      window.history.replaceState(null, '', window.location.pathname);
      return;
    }
    const checkout = params.get('suscripcion');
    if (checkout === 'ok') {
      // El success_url del Checkout no prueba el cobro (01B decide): solo se comprueba.
      void observarActivacionPlan(null, Date.now() - 10 * 60_000);
      window.history.replaceState(null, '', window.location.pathname);
      return;
    }
    if (checkout === 'cancelado') {
      toast.info('Cancelaste el checkout. Tu plan no cambió.');
      window.history.replaceState(null, '', window.location.pathname);
      return;
    }
    if (pendiente) {
      if (pendiente.estado === 'confirmado') void observarActivacionPlan(slugPendiente, pendiente.ts);
      else pagoNoResuelto(pendiente);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PKG-02B (C28): el plan "actual" es el de la membresía VIVA. `usuarios.membresia_tier`
  // (currentSlug) solo sirve de respaldo cuando aún no cargó la fila o no existe.
  const membresiaViva = !!membresia && ESTADOS_VIVOS.includes(membresia.status ?? '');
  const planActualSlug = (membresiaViva ? membresia?.tier?.slug : null) ?? currentSlug;
  const planActual = tiers.find((t) => t.slug === planActualSlug) ?? null;
  // Selector Membresías · Paquetes en el modal de cambio (igual que la landing).
  const enVenta = tiers.filter((t) => t.vendible);
  const planesMensuales = enVenta.filter((t) => !esPlanPaquete(t));
  const planesPaquetes = enVenta.filter((t) => esPlanPaquete(t));
  const hayAmbosTipos = planesMensuales.length > 0 && planesPaquetes.length > 0;
  const planesVisibles = vistaPlan === 'paquetes' ? planesPaquetes : planesMensuales;
  const statusMeta = STATUS_META[status ?? ''] ?? { texto: status ?? '—', clase: 'ek-badge--neutral' };
  const tieneSuscripcion = !!membresia?.stripe_subscription_id;
  const creditos = membresia?.creditos_restantes ?? null; // null = plan mensual (ilimitado)
  const pagoVencido = membresia?.status === 'past_due';
  const cancelaAlFin = membresia?.cancel_at_period_end === true;
  const finPeriodo = membresia?.periodo_actual_fin
    ? new Date(membresia.periodo_actual_fin).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  // Decide el flujo del cambio de plan: swap in-place (tarjeta guardada) cuando
  // hay una suscripción vigente y el destino es mensual; si no, modal de pago.
  function cambiarPlan(destino: TierInfo) {
    // Aviso: pasar de un paquete con créditos restantes a un plan mensual
    // (ilimitado) descarta el saldo. Que sea una elección consciente.
    const saldo = membresia?.creditos_restantes ?? 0;
    if (saldo > 0 && !esPlanPaquete(destino)) {
      setConfirmarCambio(destino);
      return;
    }
    // Destino mensual → intentar re-precio sin re-pedir tarjeta (cobra la
    // guardada, proration al próximo período). NO gateamos por `tieneSuscripcion`
    // del front (se calcula de la fila más reciente y puede estar desfasada): el
    // endpoint busca la suscripción activa real y responde 'sin_suscripcion' si
    // de verdad no hay — ahí sí caemos al modal de pago. `past_due` va directo al
    // modal (la tarjeta está fallando; hay que recolectarla).
    if (!pagoVencido && !esPlanPaquete(destino)) {
      void hacerSwap(destino);
      return;
    }
    setCambiarOpen(false);
    setPagarTier(destino);
  }

  // Cambio in-place de la suscripción vigente usando la tarjeta guardada.
  async function hacerSwap(destino: TierInfo) {
    setSwapping(destino.slug);
    try {
      const res = await cambiarPlanSuscripcion(destino.slug);
      // Sin suscripción/pasarela → caer al pago normal (PaymentModal).
      if (res.reason) {
        setCambiarOpen(false);
        setPagarTier(destino);
        return;
      }
      if (!res.success) throw new Error();
      setCambiarOpen(false);
      toast.success(`¡Listo! Cambiaste a ${destino.nombre}. El ajuste se refleja en tu próximo cobro.`);
      // El tier cambió server-side; recargamos para reflejar el plan actual.
      setTimeout(() => window.location.reload(), 1400);
    } catch {
      toast.error('No pudimos cambiar tu plan. Intenta de nuevo.');
    } finally {
      setSwapping(null);
    }
  }

  function procederCambio(destino: TierInfo) {
    // Viene del aviso "pierdes tus créditos": es un miembro de PAQUETE (sin
    // suscripción) pasando a mensual → siempre por el modal de pago.
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
      ) : errorCarga ? (
        <div className="ek-card">
          <ErrorCarga
            titulo="No pudimos cargar tu plan."
            hint="Tu suscripción sigue igual; solo no pudimos leerla. Revisa tu conexión e intenta de nuevo."
            onReintentar={() => setIntentoCarga((n) => n + 1)}
          />
        </div>
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

          {/* PKG-02B: pago confirmado/en proceso → activación pendiente (nunca "activo" sin verlo). */}
          {activacion && (
            <div role="status" data-testid="activacion-pendiente" className="ek-card" style={{ marginBottom: '16px', borderColor: 'var(--ek-mustard)' }}>
              <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>
                {activacion.estado === 'en_proceso' ? 'PAGO EN PROCESO' : activacion.estado === 'desconocido' ? 'PAGO SIN CONFIRMAR' : 'PAGO RECIBIDO'}
              </p>
              <p className="ek-body-muted" style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
                {activacion.estado === 'observando'
                  ? MENSAJE_PAGO.recibidoActivando
                  : mensajePagoPendiente({ flujo: 'perfil', paymentIntentId: null, estado: activacion.estado === 'en_proceso' ? 'en_proceso' : activacion.estado === 'desconocido' ? 'desconocido' : 'confirmado', ts: activacion.desde })}
              </p>
              {activacion.estado === 'error' && (
                <div style={{ marginBottom: '10px' }}>
                  <ErrorInline mensaje={MENSAJE_PAGO.comprobacionFallo} />
                </div>
              )}
              {activacion.estado === 'observando' ? (
                <Spinner size={16} label="Comprobando…" />
              ) : (
                activacion.estado !== 'en_proceso' && (
                  <button type="button" className="ek-cta ek-cta--gold" style={{ padding: '9px 16px', fontSize: '13px' }} onClick={() => void observarActivacionPlan(activacion.slug, activacion.desde)}>
                    Volver a comprobar
                  </button>
                )
              )}
            </div>
          )}
          {retornoFallido && (
            <div style={{ marginBottom: '16px' }}>
              <ErrorInline mensaje={MENSAJE_PAGO.noCompletado} />
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
            {planActual && !planActual.vendible && (
              <p data-testid="plan-fuera-de-venta" style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '-6px 0 14px', lineHeight: 1.45 }}>
                Este plan ya no está a la venta. Lo conservas mientras sigas suscrito; si lo cancelas o cambias, no podrás volver a él.
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

            {/* Mientras hay un pago sin resolver no se ofrece otro cobro. */}
            {!activacion && (
              <button
                type="button"
                className="ek-cta ek-cta--gold ek-cta--full"
                onClick={() => { setVistaPlan(planActual && esPlanPaquete(planActual) ? 'paquetes' : 'membresias'); setCambiarOpen(true); }}
              >
                {planActual ? 'Cambiar de plan' : 'Ver planes'} <ArrowRight size={16} aria-hidden="true" />
              </button>
            )}

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
                      {/* Concepto (A11): qué se cobró, no solo cuánto. */}
                      <p style={{ margin: '2px 0 0', fontSize: '13px', color: 'var(--ek-ink)' }}>{p.descripcion}</p>
                      <p className="ek-body-faint" style={{ margin: 0 }}>
                        {new Date(p.fecha).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {(p.reembolsado_centavos ?? 0) > 0 && p.status !== 'refunded' && (
                          <> · Devuelto {formatearPesos(p.reembolsado_centavos ?? 0)}</>
                        )}
                        {p.receipt_url && (
                          <>
                            {' · '}
                            <a href={p.receipt_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ek-mustard)', textDecoration: 'underline' }}>
                              Ver recibo
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                    <span className={`ek-badge ${p.status === 'succeeded' ? 'ek-badge--success' : p.status === 'pending' || p.status === 'refunded' ? 'ek-badge--outline' : 'ek-badge--danger'}`}>
                      {p.status === 'succeeded' ? 'Pagado' : p.status === 'pending' ? 'Pendiente' : p.status === 'refunded' ? 'Reembolsado' : 'Falló'}
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

            {hayAmbosTipos && (
              <div style={{ marginBottom: '16px' }}>
                <PlanTipoToggle value={vistaPlan} onChange={setVistaPlan} />
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {planesVisibles.map((t) => {
                // "Actual" solo si la membresía viva es de este plan. El mismo paquete
                // agotado (sin membresía viva o sin créditos) se puede RECOMPRAR: no es
                // un cambio de plan. Un plan mensual vivo con Stripe no ofrece nada
                // (renueva solo).
                const esMismoPlan = t.slug === planActualSlug;
                const esActual = esMismoPlan && membresiaViva && !(esPlanPaquete(t) && (creditos ?? 0) <= 0);
                const recompra = esMismoPlan && esPlanPaquete(t) && !esActual;
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
                        onClick={() => (recompra ? (setCambiarOpen(false), setPagarTier(t)) : cambiarPlan(t))}
                        disabled={swapping !== null}
                      >
                        {swapping === t.slug ? (
                          <Spinner size={15} />
                        ) : recompra ? (
                          <>Recomprar <ArrowRight size={15} aria-hidden="true" /></>
                        ) : (
                          <>Elegir este <ArrowRight size={15} aria-hidden="true" /></>
                        )}
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
          flujo="perfil"
          contexto={{ slug: pagarTier.slug }}
          onClose={() => setPagarTier(null)}
          onPagado={(pago) => {
            const slug = pagarTier.slug;
            setPagarTier(null);
            setCambiarOpen(false);
            pagoConfirmado(pago.paymentIntentId, slug);
          }}
          onEnProceso={(pago) => {
            const slug = pagarTier.slug;
            setPagarTier(null);
            setCambiarOpen(false);
            pagoNoResuelto(guardarPagoPendiente({ flujo: 'perfil', paymentIntentId: pago.paymentIntentId, estado: 'en_proceso', contexto: { slug } }));
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
