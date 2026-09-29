import { useEffect, useState } from 'react';
import { Sparkles, Check, ArrowRight, X } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { parseBeneficios } from '@shared/lib/beneficios';
import { sufijoPrecio, esPlanPaquete, detallePlan } from '@shared/lib/planPresentacion';
import { PaymentModal } from '@shared/components/PaymentModal';
import { PlanTipoToggle, type VistaPlan } from '@shared/components/PlanTipoToggle';
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

/**
 * Pantalla para el miembro con cuenta `pendiente_pago`: paga su membresía y se
 * activa (self-serve). Arranca con el plan que eligió al registrarse, pero puede
 * CAMBIARLO aquí — la activación toma el plan del pago (metadata de la sub/PI),
 * así que pagar otro plan lo corrige. Al pagar, el webhook activa la cuenta.
 */
interface TierInfo {
  slug: string;
  nombre: string;
  precio_centavos: number;
  tipo: string;
  clases_incluidas: number | null;
  duracion_dias: number | null;
  beneficios: string[];
}

function pesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

export default function PagarMembresia() {
  const { usuario, signOut, refreshUsuario } = useAuth();
  const tenant = useTenant();
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // PKG-02A (C02 · F17): fallo al leer los planes ≠ "no hay planes disponibles".
  const [errorPlanes, setErrorPlanes] = useState(false);
  const [intento, setIntento] = useState(0);
  const [pagarOpen, setPagarOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // PKG-02B (C04): tras un pago con `succeeded` la cuenta NO está activa hasta
  // observarlo (usuarios.status ≠ pendiente_pago). Mientras haya un pago
  // confirmado/en proceso/desconocido sin resolver, NO se vuelve a ofrecer "Pagar".
  const [pendiente, setPendiente] = useState<PagoPendiente | null>(() => leerPagoPendiente('pagar'));
  const [activacion, setActivacion] = useState<'idle' | 'observando' | 'no_observada' | 'error'>('idle');
  // null = usar el plan del signup; si el usuario elige otro, gana este.
  const [slugElegido, setSlugElegido] = useState<string | null>(null);
  const [vistaPlan, setVistaPlan] = useState<VistaPlan>('membresias');

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setErrorPlanes(false);
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, tipo, clases_incluidas, duracion_dias, beneficios')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .eq('en_venta', true)
        .order('orden', { ascending: true });
      if (!mounted) return;
      if (error) {
        console.error('[PagarMembresia]', error);
        setErrorPlanes(true);
        setLoading(false);
        return;
      }
      setTiers(
        (data ?? []).map((d) => ({
          slug: d.slug,
          nombre: d.nombre,
          precio_centavos: d.precio_centavos,
          tipo: d.tipo,
          clases_incluidas: d.clases_incluidas,
          duracion_dias: d.duracion_dias,
          beneficios: parseBeneficios(d.beneficios).filter((b) => b.incluido).map((b) => b.label).slice(0, 5)
        }))
      );
      setLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, intento]);

  // Retorno de un método con redirección (iDEAL/Bancontact/EPS): leer el estado real.
  useEffect(() => {
    const r = leerRetornoPago(window.location.search);
    if (r.flujo !== 'pagar' || r.estado === null) return;
    if (r.estado === 'succeeded') {
      setPendiente(guardarPagoPendiente({ flujo: 'pagar', paymentIntentId: r.paymentIntentId, estado: 'confirmado' }));
    } else if (r.estado === 'processing') {
      setPendiente(guardarPagoPendiente({ flujo: 'pagar', paymentIntentId: r.paymentIntentId, estado: 'en_proceso' }));
    } else if (r.estado === 'desconocido') {
      setPendiente(guardarPagoPendiente({ flujo: 'pagar', paymentIntentId: r.paymentIntentId, estado: 'desconocido' }));
    } else {
      // failed → no se afirma cargo; el CTA "Pagar" sigue disponible.
      setRetornoFallido(true);
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [retornoFallido, setRetornoFallido] = useState(false);

  // Observar la activación (solo LECTURA de usuarios.status). Éxito = la cuenta
  // dejó de estar pendiente de pago; entonces refreshUsuario y MemberLayout deja
  // pasar. Timeout ≠ fallo del pago; error de lectura ≠ "no se activó".
  async function comprobarActivacion() {
    if (!usuario?.id) return;
    setActivacion('observando');
    const obs = await observarActivacion<{ status: string | null }>({
      leer: async () => {
        const { data, error } = await supabase.from('usuarios').select('status').eq('id', usuario.id).maybeSingle();
        return { data: (data as { status: string | null } | null) ?? null, error };
      },
      listo: (u) => u.status !== null && u.status !== 'pendiente_pago'
    });
    if (obs.resultado === 'observada') {
      limpiarPagoPendiente();
      setPendiente(null);
      setActivacion('idle');
      await refreshUsuario(); // MemberLayout re-evalúa el gate y entra a la app
      return;
    }
    setActivacion(obs.resultado === 'error' ? 'error' : 'no_observada');
  }

  useEffect(() => {
    // Solo un pago CONFIRMADO se observa solo; en_proceso/desconocido esperan al webhook.
    if (pendiente?.estado === 'confirmado' && activacion === 'idle') void comprobarActivacion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendiente?.paymentIntentId, pendiente?.estado]);

  const slug = slugElegido ?? usuario?.membresia_tier ?? tiers[0]?.slug ?? null;
  const tier = tiers.find((t) => t.slug === slug) ?? null;
  const esPaquete = tier?.tipo === 'creditos' || tier?.tipo === 'hibrido';

  // Selector Membresías · Paquetes en el picker (igual que la landing).
  const planesMensuales = tiers.filter((t) => !esPlanPaquete(t));
  const planesPaquetes = tiers.filter((t) => esPlanPaquete(t));
  const hayAmbosTipos = planesMensuales.length > 0 && planesPaquetes.length > 0;
  const planesVisibles = vistaPlan === 'paquetes' ? planesPaquetes : planesMensuales;

  if (pendiente) {
    const confirmado = pendiente.estado === 'confirmado';
    const observando = activacion === 'observando';
    return (
      <div data-testid="pago-pendiente" style={{ maxWidth: '460px', margin: '0 auto', padding: '48px 24px', textAlign: 'center' }}>
        <span className="ek-empty-icon" style={{ width: 56, height: 56, marginBottom: '16px' }}>
          <Check size={26} aria-hidden="true" />
        </span>
        <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '24px', fontWeight: 700, margin: '0 0 8px' }}>
          {confirmado ? 'Pago recibido' : pendiente.estado === 'en_proceso' ? 'Pago en proceso' : 'Pago sin confirmar'}
        </h1>
        <p className="ek-body-muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
          {observando ? MENSAJE_PAGO.recibidoActivando : mensajePagoPendiente(pendiente)}
        </p>
        {activacion === 'error' && (
          <div style={{ marginBottom: '14px', textAlign: 'left' }}>
            <ErrorInline mensaje={MENSAJE_PAGO.comprobacionFallo} />
          </div>
        )}
        {observando ? (
          <Spinner size={20} />
        ) : (
          confirmado && (
            <button type="button" className="ek-cta ek-cta--gold" onClick={() => void comprobarActivacion()}>
              Volver a comprobar
            </button>
          )
        )}
        <p className="ek-helper-text" style={{ marginTop: '18px' }}>
          Si después de unos minutos sigue sin activarse, acércate a recepción: pueden verificar tu pago. No pagues otra vez.
        </p>
        <button
          type="button"
          onClick={signOut}
          style={{ display: 'block', margin: '14px auto 0', fontSize: '13px', color: 'var(--ek-ink-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          Salir
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '460px', margin: '0 auto', padding: '40px 24px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>ÚLTIMO PASO</p>
      <h1 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '26px', fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
        Activa tu membresía
      </h1>
      <p className="ek-body-muted" style={{ margin: '0 0 24px' }}>
        Tu cuenta está creada. Paga tu plan para empezar a reservar.
      </p>

      {loading ? (
        <div className="ek-card"><Spinner label="Cargando planes…" /></div>
      ) : errorPlanes ? (
        <div className="ek-card">
          <ErrorCarga titulo="No pudimos cargar los planes." onReintentar={() => setIntento((n) => n + 1)} />
        </div>
      ) : !tier ? (
        <div className="ek-card">
          <p className="ek-body-muted" style={{ margin: 0 }}>
            No hay planes disponibles. Acércate a recepción para activar tu cuenta.
          </p>
        </div>
      ) : (
        <>
          <div className="ek-card--hero" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
              <span className="ek-empty-icon" style={{ width: 44, height: 44, margin: 0 }}>
                <Sparkles size={20} aria-hidden="true" />
              </span>
              <div>
                <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>TU PLAN</p>
                <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '20px', fontWeight: 700, margin: 0 }}>{tier.nombre}</h3>
              </div>
            </div>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '32px', fontWeight: 700, margin: '0 0 14px', letterSpacing: '-0.03em' }}>
              {pesos(tier.precio_centavos)}
              <span style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>{sufijoPrecio(tier)}</span>
            </p>
            {tier.beneficios.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {tier.beneficios.map((b, i) => (
                  <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                    <Check size={15} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {retornoFallido && (
            <div style={{ marginBottom: '12px' }}>
              <ErrorInline mensaje={MENSAJE_PAGO.noCompletado} />
            </div>
          )}
          <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => setPagarOpen(true)}>
            Pagar ahora
          </button>

          {tiers.length > 1 && (
            <button
              type="button"
              onClick={() => { setVistaPlan(esPaquete ? 'paquetes' : 'membresias'); setPickerOpen(true); }}
              className="ek-cta ek-cta--secondary ek-cta--full"
              style={{ marginTop: '10px' }}
            >
              Cambiar de plan <ArrowRight size={15} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={signOut}
            style={{ display: 'block', margin: '14px auto 0', fontSize: '13px', color: 'var(--ek-ink-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Salir
          </button>

          {/* Selector de plan */}
          {pickerOpen && (
            <div className="ek-backdrop" onClick={() => setPickerOpen(false)} role="dialog" aria-modal="true">
              <div onClick={(e) => e.stopPropagation()} className="ek-card" style={{ maxWidth: '460px', width: '100%', maxHeight: '86vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>ELIGE TU PLAN</p>
                  <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={() => setPickerOpen(false)}>
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
                {hayAmbosTipos && (
                  <div style={{ marginBottom: '14px' }}>
                    <PlanTipoToggle value={vistaPlan} onChange={setVistaPlan} />
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {planesVisibles.map((t) => {
                    const seleccionado = t.slug === slug;
                    return (
                      <div
                        key={t.slug}
                        className="ek-card ek-card--md ek-card--cream"
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', border: seleccionado ? '1.5px solid var(--ek-mustard)' : undefined }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(10, 10, 10, 0.6)' }}>{t.nombre}</span>
                            {seleccionado && (
                              <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ek-bg)', background: 'rgba(10, 10, 10, 0.1)', padding: '2px 8px', borderRadius: '999px' }}>
                                Elegido
                              </span>
                            )}
                          </div>
                          <p style={{ margin: 0, fontWeight: 700, color: 'var(--ek-bg)' }}>
                            {pesos(t.precio_centavos)}<span style={{ color: 'rgba(10, 10, 10, 0.55)', fontWeight: 500, fontSize: '13px' }}>{sufijoPrecio(t)}</span>
                          </p>
                          <p style={{ margin: '2px 0 0', fontSize: '11px', color: 'rgba(10, 10, 10, 0.55)' }}>{detallePlan(t)}</p>
                        </div>
                        {seleccionado ? (
                          <Check size={18} style={{ color: 'var(--ek-bg)', flexShrink: 0 }} aria-hidden="true" />
                        ) : (
                          <button
                            type="button"
                            className="ek-cta ek-cta--gold"
                            style={{ padding: '10px 14px', fontSize: '13px', whiteSpace: 'nowrap', flexShrink: 0, gap: '6px' }}
                            onClick={() => { setSlugElegido(t.slug); setPickerOpen(false); }}
                          >
                            Elegir este <ArrowRight size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {pagarOpen && (
            <PaymentModal
              tierSlug={tier.slug}
              tierNombre={tier.nombre}
              precio={Math.round(tier.precio_centavos / 100)}
              esPaquete={esPaquete}
              flujo="pagar"
              onClose={() => setPagarOpen(false)}
              onPagado={(pago) => {
                // PAGO CONFIRMADO ≠ CUENTA ACTIVA: se observa la activación; nada de reload ciego.
                setPagarOpen(false);
                setPendiente(guardarPagoPendiente({ flujo: 'pagar', paymentIntentId: pago.paymentIntentId, estado: 'confirmado' }));
              }}
              onEnProceso={(pago) => {
                setPagarOpen(false);
                setPendiente(guardarPagoPendiente({ flujo: 'pagar', paymentIntentId: pago.paymentIntentId, estado: 'en_proceso' }));
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
