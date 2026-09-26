import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarX } from 'lucide-react';
import { EmptyState } from '@shared/components/EmptyState';
import { ContactoEstudio } from '@shared/components/ContactoEstudio';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useVisibilityAwarePolling } from '@shared/hooks/useVisibilityAwarePolling';
import { useToast } from '@shared/hooks/useToast';
import { celebrar } from '@shared/lib/celebrar';
import { PaymentModal } from '@shared/components/PaymentModal';
import { elegirPaquetePorHora, type PlanCandidato } from '../logic/sesionSuelta';
import { supabase } from '@shared/lib/supabase';
import { crearPagoInvitados } from '@shared/lib/checkout';
import {
  useRecursosDelTenant,
  fetchReservasDelRecurso,
  fetchReservasDelUsuario,
  crearReserva
} from '../hooks/useReservas';
import {
  generarSlotsDisponibles,
  generarFechasReservables,
  formatHora,
  puedeReservarRecurso,
  type TenantReservaConfig,
  type Slot
} from '../logic/reservaLogic';
import { useResumenMiembro } from '../hooks/useResumenMiembro';
import type { Database } from '@shared/types/database';
import { rangoDiaEnZona, formatFechaEnZona } from '@shared/lib/timezone';

/** Créditos que descuenta reservar este estudio (default 1). */
function costoCreditos(recurso: Recurso | null): number {
  return Math.max(1, recurso?.costo_creditos ?? 1);
}

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Reservar() {
  const tenant = useTenant();
  const { usuario, refreshUsuario } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const recursoSlugParam = searchParams.get('recurso');
  const { recursos, isLoading: loadingRecursos } = useRecursosDelTenant();

  const config = useMemo<TenantReservaConfig>(() => {
    const c = (tenant.config as Record<string, any>)?.reserva ?? {};
    return {
      duracion_default_min: c.duracion_default_min ?? 60,
      cupos_por_recurso: c.cupos_por_recurso ?? 1,
      permitir_continuas: c.permitir_continuas ?? false,
      anticipacion_min_horas: c.anticipacion_min_horas ?? 24,
      anticipacion_max_dias: c.anticipacion_max_dias ?? 30,
      ventana_check_in_min: c.ventana_check_in_min ?? 15
    };
  }, [tenant.config]);

  // Ver estudios y horarios es LIBRE para cualquier cuenta. El freno va solo en
  // el momento de reservar (necesitas plan/créditos), no en explorar.
  const tienePlan = !!usuario?.membresia_tier;

  // Saldo de créditos (null = plan por tiempo/ilimitado → no aplica el costo).
  const { resumen, refetch: refetchResumen } = useResumenMiembro(usuario?.id, tenant.id, usuario?.membresia_tier);
  const saldoCreditos = resumen.membresia?.creditosRestantes ?? null;
  const esPlanCreditos = saldoCreditos !== null;

  const fechas = useMemo(() => generarFechasReservables(config), [config]);

  const [recursoSel, setRecursoSel] = useState<Recurso | null>(null);
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [errorSlots, setErrorSlots] = useState<string | null>(null);
  // Se incrementa para volver a pedir la disponibilidad sin mostrar skeleton.
  const [refresco, setRefresco] = useState(0);
  const claveCargada = useRef<string | null>(null);
  const [slotPendiente, setSlotPendiente] = useState<Slot | null>(null);
  const [invitados, setInvitados] = useState(0);
  const [invitadosExtra, setInvitadosExtra] = useState(0);
  const [pagarInvitados, setPagarInvitados] = useState<{ reservaId: string; cantidad: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // "Pago por hora": si no alcanza el saldo, se ofrece comprar el paquete más chico
  // que sirva para ESTA hora y reservarla en cuanto se acredite.
  const [planes, setPlanes] = useState<PlanCandidato[]>([]);
  const [comprarPara, setComprarPara] = useState<{ slot: Slot; plan: PlanCandidato } | null>(null);
  const [pagando, setPagando] = useState(false);
  const [activando, setActivando] = useState(false);

  useEffect(() => {
    let vivo = true;
    void supabase
      .from('tiers')
      .select('slug, nombre, precio_centavos, tipo, clases_incluidas, activo, en_venta')
      .eq('tenant_id', tenant.id)
      .then(({ data }) => {
        if (vivo) setPlanes((data ?? []) as PlanCandidato[]);
      });
    return () => {
      vivo = false;
    };
  }, [tenant.id]);

  // Invitados permitidos: del plan del miembro (Admin → Planes → Máx. invitados).
  const maxInvitados = resumen.tier?.maxInvitados ?? 0;
  // Precio de invitado extra (config del tenant) + tope por estudio (admin).
  // Ambos >0 habilitan el cobro de extras en la app.
  const precioExtraCentavos = Number((tenant.config as Record<string, any>)?.reserva?.precio_invitado_extra_centavos) || 0;
  const precioExtraPesos = Math.round(precioExtraCentavos / 100);
  const maxExtraEstudio = recursoSel?.max_invitados_extra ?? 0;
  const permiteExtras = precioExtraCentavos > 0 && maxExtraEstudio > 0;

  // Motivo por el que NO se puede reservar (null = puede). Ver siempre se permite.
  const saldoInsuficiente =
    esPlanCreditos && saldoCreditos !== null && recursoSel !== null &&
    saldoCreditos < costoCreditos(recursoSel);
  // Antes solo se miraba "¿tiene plan?" y el saldo: un miembro Esencial elegía un
  // estudio Premium, elegía hora, confirmaba… y recién ahí el servidor le decía
  // que su plan no lo incluye. Lo mismo con una restricción por inasistencias.
  // Se avisa ANTES de que pierda el tiempo, con el mismo criterio que el servidor.
  const bloqueadoHasta =
    usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta).getTime() > Date.now()
      ? usuario.bloqueado_hasta
      : null;
  const planNoIncluyeEstudio =
    tienePlan && recursoSel !== null && !puedeReservarRecurso(recursoSel, usuario?.membresia_tier ?? null);
  const motivoNoReserva = bloqueadoHasta
    ? `Tienes una restricción para reservar hasta el ${formatFechaEnZona(bloqueadoHasta, { day: 'numeric', month: 'long' })}.`
    : !tienePlan
    ? 'Necesitas un plan para reservar. Puedes ver todo mientras tanto.'
    : planNoIncluyeEstudio
    ? 'Tu plan no incluye este estudio. Puedes cambiar de plan desde tu perfil.'
    : saldoInsuficiente
    ? 'No te alcanzan los créditos para este estudio.'
    : null;

  // Resetear invitados cuando se abre/cierra el modal
  useEffect(() => {
    if (!slotPendiente) { setInvitados(0); setInvitadosExtra(0); }
  }, [slotPendiente]);

  // Auto-seleccionar el estudio del query param (?recurso=slug) o el primero.
  useEffect(() => {
    if (recursoSel || recursos.length === 0) return;
    const found = recursoSlugParam
      ? recursos.find((r) => r.slug === recursoSlugParam)
      : null;
    setRecursoSel(found ?? recursos[0]);
  }, [recursos, recursoSel, recursoSlugParam]);

  // Recargar slots cuando cambia recurso o fecha
  useEffect(() => {
    if (!recursoSel || !fechaSel || !usuario) return;

    let mounted = true;
    // Skeleton solo al cambiar de set o de fecha; el refresco periódico es silencioso.
    const clave = `${recursoSel.id}|${fechaSel}`;
    const esRefresco = claveCargada.current === clave;
    if (!esRefresco) setLoadingSlots(true);

    // Día del ESTUDIO (no del navegador): [00:00, 24:00) en America/Mazatlan.
    const { inicio: fechaInicio, fin: fechaFin } = rangoDiaEnZona(fechaSel);

    Promise.all([
      fetchReservasDelRecurso(recursoSel.id, fechaInicio, fechaFin),
      fetchReservasDelUsuario(usuario.id, fechaInicio, fechaFin)
    ])
      .then(([reservasRecurso, reservasUsuario]) => {
        if (!mounted) return;
        const generados = generarSlotsDisponibles(
          recursoSel,
          fechaSel,
          config,
          reservasRecurso,
          reservasUsuario
        );
        claveCargada.current = clave;
        setSlots(generados);
        setErrorSlots(null);
        setLoadingSlots(false);
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        // Falló la carga: NO se pintan horarios (antes un error devolvía [] y todo
        // salía "libre"). En un refresco silencioso se conserva lo que ya había.
        if (!esRefresco) {
          setSlots([]);
          setErrorSlots(e instanceof Error ? e.message : 'No se pudo cargar la disponibilidad.');
        }
        setLoadingSlots(false);
      });

    return () => { mounted = false; };
  }, [recursoSel, fechaSel, usuario, config, refresco]);

  // "La disponibilidad deberá actualizarse en tiempo real para todos los usuarios":
  // mientras la pantalla está visible se vuelve a pedir cada 20 s (y al volver a la
  // pestaña). Por sondeo y no por Realtime a propósito: Realtime respeta RLS y un
  // miembro no recibe los cambios en reservas AJENAS, que son justo los que importan.
  // `refrescar` con identidad ESTABLE: el hook lo ejecuta al montar y vuelve a
  // ejecutarlo cada vez que cambia; una arrow inline aquí recreaba la función en
  // cada render → setRefresco → render → … (bucle infinito de recargas).
  const primerTick = useRef(true);
  const refrescar = useCallback(() => {
    // La carga inicial ya la hace el efecto de arriba: el primer tick no cuenta.
    if (primerTick.current) {
      primerTick.current = false;
      return;
    }
    setRefresco((n) => n + 1);
  }, []);
  useVisibilityAwarePolling(
    refrescar,
    20_000,
    Boolean(recursoSel && fechaSel && usuario) && !slotPendiente && !comprarPara && !activando
  );

  /**
   * Tras pagar el paquete, la activación llega por el webhook de Stripe (segundos).
   * Se sondea el saldo hasta que alcance para esta hora y entonces se reserva. Si
   * en ~30 s no se acreditó, el pago sigue siendo válido: los créditos aparecen
   * solos y la hora se elige de nuevo.
   */
  async function reservarTrasPago(slot: Slot, costo: number) {
    if (!recursoSel) return;
    setActivando(true);
    try {
      let saldo = -1;
      for (let intento = 0; intento < 12; intento++) {
        await new Promise((r) => setTimeout(r, 2500));
        await refetchResumen();
        const { data } = await supabase
          .from('membresias')
          .select('creditos_restantes')
          .eq('usuario_id', usuario!.id)
          .in('status', ['trialing', 'activa', 'past_due'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        saldo = data?.creditos_restantes ?? -1;
        if (saldo >= costo) break;
      }
      await refreshUsuario();
      if (saldo < costo) {
        toast.warning('Tu pago se recibió, pero la acreditación tarda más de lo normal. En cuanto aparezcan tus créditos, elige tu hora otra vez.', 12_000);
        setRefresco((n) => n + 1);
        return;
      }
      const res = await crearReserva({
        recursoId: recursoSel.id,
        slotInicio: slot.inicio,
        duracionMin: config.duracion_default_min
      });
      celebrar();
      toast.success(`Reserva confirmada · ${formatFechaEnZona(slot.inicio, { weekday: 'long', day: 'numeric', month: 'long' })}, ${formatHora(slot.inicio)}`);
      const reservaId: string | undefined = (res as { reserva_id?: string })?.reserva_id;
      navigate(reservaId ? `/app/qr/${reservaId}?nueva=1` : '/app');
    } catch (e) {
      // Ya tiene los créditos: si la hora se ocupó mientras pagaba, que elija otra.
      toast.error(e instanceof Error ? e.message : 'No se pudo reservar. Tus créditos ya están en tu cuenta: elige otra hora.', 10_000);
      setRefresco((n) => n + 1);
    } finally {
      setActivando(false);
    }
  }

  async function confirmarReserva() {
    if (!slotPendiente || !recursoSel) return;
    setSubmitting(true);
    const extra = invitadosExtra;
    try {
      const res = await crearReserva({
        recursoId: recursoSel.id,
        slotInicio: slotPendiente.inicio,
        duracionMin: config.duracion_default_min,
        invitados,
        notas: undefined
      });
      setSlotPendiente(null);
      setSubmitting(false);
      const fechaFmt = formatFechaEnZona(slotPendiente.inicio, { weekday: 'long', day: 'numeric', month: 'long' });
      const horaFmt = formatHora(slotPendiente.inicio);
      celebrar();
      toast.success(`Reserva confirmada · ${fechaFmt}, ${horaFmt}`);
      // Si eligió invitados extra, abre el pago (Stripe). Si no, sigue al inicio.
      const reservaId: string | undefined = (res as { reserva_id?: string })?.reserva_id;
      if (extra > 0 && reservaId) {
        setPagarInvitados({ reservaId, cantidad: extra });
      } else {
        // Al detalle de la reserva recién hecha (su QR), no al inicio: ahí está
        // "Agregar al calendario", que el cliente pidió justo al momento de reservar.
        navigate(reservaId ? `/app/qr/${reservaId}?nueva=1` : '/app');
      }
    } catch (e) {
      // Sin el viejo sufijo "· Inténtalo otra vez": el mensaje ya dice qué hacer, y
      // la mayoría de estos errores (plan, créditos, restricción) NO se arreglan
      // reintentando.
      toast.error(e instanceof Error ? e.message : 'No se pudo crear la reserva. Inténtalo otra vez.');
      // Alguien se adelantó (o hay otro set en uso): refrescar la grilla YA.
      setSlotPendiente(null);
      setRefresco((n) => n + 1);
      setSubmitting(false);
    }
  }

  if (loadingRecursos) {
    return (
      <div className="ek-container">
        <div className="ek-stack-md">
          <div className="ek-skeleton" style={{ height: '40px', width: '60%', borderRadius: 'var(--ek-r-sm)' }} />
          <div className="ek-skeleton" style={{ height: '120px', borderRadius: 'var(--ek-r-md)' }} />
        </div>
      </div>
    );
  }

  if (recursos.length === 0) {
    return (
      <div className="ek-container">
        <EmptyState
          icon={CalendarX}
          tone="neutral"
          title="Sin estudios disponibles"
          hint="No hay estudios activos en este momento."
          action={<ContactoEstudio mensaje="Hola, quiero reservar pero la app no muestra estudios disponibles." />}
        />
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        {/* Selector de recurso */}
        <div className="ek-stack-sm">
          <label className="ek-field-label">Estudio</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {recursos.map((r) => {
              const activo = recursoSel?.id === r.id;
              return (
                <button
                  key={r.id}
                  className={`ek-chip ${activo ? 'ek-chip--active' : ''}`}
                  onClick={() => setRecursoSel(r)}
                >
                  {r.nombre}
                </button>
              );
            })}
          </div>

          {/* Preview del estudio seleccionado: misma card de foto (mismo tamaño)
              que el hero del inicio, para que sepan cuál están eligiendo. */}
          {recursoSel && (
            <div className="ek-hero-foto" style={{ marginTop: '12px', background: 'var(--ek-bg-elevated)' }}>
              {recursoSel.foto_url && (
                <img className="ek-hero-foto-img" src={recursoSel.foto_url} alt={recursoSel.nombre} loading="lazy" />
              )}
              <div className="ek-hero-foto-scrim" />
              <div className="ek-hero-foto-body">
                <h3 style={{ fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, letterSpacing: '-0.02em', margin: 0, color: '#fff' }}>
                  {recursoSel.nombre}
                </h3>
                {(recursoSel.descripcion || recursoSel.capacidad_personas) && (
                  <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'rgba(255,255,255,0.72)' }}>
                    {recursoSel.descripcion
                      ? recursoSel.descripcion
                      : `Hasta ${recursoSel.capacidad_personas} ${recursoSel.capacidad_personas === 1 ? 'persona' : 'personas'}`}
                  </p>
                )}
                {esPlanCreditos && (
                  <div style={{ marginTop: '10px', display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        fontSize: '12px',
                        fontWeight: 700,
                        color: '#111',
                        background: 'var(--ek-mustard)',
                        padding: '4px 10px',
                        borderRadius: '999px'
                      }}
                    >
                      Cuesta {costoCreditos(recursoSel)} {costoCreditos(recursoSel) === 1 ? 'crédito' : 'créditos'}
                    </span>
                    <span style={{ fontSize: '12px', color: saldoCreditos! < costoCreditos(recursoSel) ? '#ffb4b4' : 'rgba(255,255,255,0.72)' }}>
                      {saldoCreditos! < costoCreditos(recursoSel)
                        ? 'No te alcanza el saldo'
                        : `Te quedan ${saldoCreditos}`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Aviso: sin plan puedes explorar todo, pero no reservar. */}
        {!tienePlan && (
          <div
            className="ek-card ek-card--md"
            style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' }}
          >
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--ek-ink-muted)' }}>
              Puedes explorar estudios y horarios. Para <strong style={{ color: 'var(--ek-ink)' }}>reservar</strong> necesitas un plan.
            </p>
            <button
              type="button"
              onClick={() => navigate('/app/perfil')}
              className="ek-cta ek-cta--gold"
              style={{ padding: '8px 16px', fontSize: '13px', flexShrink: 0 }}
            >
              Ver planes
            </button>
          </div>
        )}

        {/* Selector de fecha */}
        <div className="ek-stack-sm">
          <label className="ek-field-label">Fecha</label>
          <div className="ek-hscroll-fade">
            <div
              className="ek-no-scrollbar"
              style={{
                display: 'flex',
                gap: '0.5rem',
                overflowX: 'auto',
                scrollSnapType: 'x proximity'
              }}
            >
              {fechas.slice(0, 14).map((f) => {
                const activo = fechaSel === f.fechaISO;
                return (
                  <button
                    key={f.fechaISO}
                    onClick={() => setFechaSel(f.fechaISO)}
                    className={`ek-chip ${activo ? 'ek-chip--active' : ''}`}
                    style={{ scrollSnapAlign: 'start', borderRadius: 'var(--ek-r-sm)', fontSize: '13px' }}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Grid de slots */}
        <div className="ek-stack-sm">
          <label className="ek-field-label">Horario</label>
          {loadingSlots ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="ek-skeleton"
                  style={{ height: '52px', borderRadius: 'var(--ek-r-sm)' }}
                />
              ))}
            </div>
          ) : errorSlots ? (
            <div className="ek-card ek-card--md" role="alert" style={{ textAlign: 'center' }}>
              <p style={{ margin: 0, fontWeight: 600 }}>No se pudo cargar la disponibilidad</p>
              <p className="ek-body-faint" style={{ margin: '4px 0 12px' }}>{errorSlots}</p>
              <button type="button" className="ek-cta ek-cta--secondary" onClick={() => setRefresco((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          ) : slots.length === 0 ? (
            <p className="ek-body-muted">
              El estudio no opera este día.
            </p>
          ) : slots.every((s) => !s.disponible) ? (
            <div className="ek-card ek-card--md" style={{ textAlign: 'center' }}>
              <p style={{ margin: 0, fontWeight: 600 }}>No quedan horarios disponibles</p>
              <p className="ek-body-faint" style={{ margin: '4px 0 0' }}>
                Todos los horarios de este día ya pasaron o están reservados. Prueba otra fecha.
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {slots.map((slot, i) => {
                const tooltip = slot.disponible
                  ? undefined
                  : slot.razon === 'pasado' ? 'Ya pasó'
                  : slot.razon === 'ocupado' ? 'Ya reservado'
                  : slot.razon === 'otro_set' ? 'Otro set en uso a esa hora'
                  : slot.razon === 'continuo' ? 'No puedes reservar continuas'
                  : slot.razon === 'anticipacion_insuficiente' ? 'Anticipación insuficiente'
                  : 'No disponible';

                return (
                  <button
                    key={i}
                    className="ek-slot"
                    disabled={!slot.disponible}
                    onClick={() => {
                      if (motivoNoReserva) {
                        // Sin plan o sin saldo: en vez de solo avisar, ofrecer pagar la hora.
                        const faltaSaldo = !bloqueadoHasta && !planNoIncluyeEstudio && (!tienePlan || saldoInsuficiente);
                        const plan = faltaSaldo && recursoSel ? elegirPaquetePorHora(planes, recursoSel, saldoCreditos ?? 0) : null;
                        if (plan) {
                          setComprarPara({ slot, plan });
                          return;
                        }
                        toast.warning(motivoNoReserva);
                        return;
                      }
                      setSlotPendiente(slot);
                    }}
                    title={tooltip}
                  >
                    {formatHora(slot.inicio)}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal de confirmación */}
        {slotPendiente && recursoSel && (
          <div
            className="ek-modal-backdrop"
            onClick={() => !submitting && setSlotPendiente(null)}
          >
            <div className="ek-modal" onClick={(e) => e.stopPropagation()}>
              <div className="ek-modal-handle" />
              <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>CONFIRMAR RESERVA</p>
              <h3 className="ek-display-md" style={{ marginBottom: '8px' }}>{recursoSel.nombre}</h3>
              <p className="ek-body-muted" style={{ marginBottom: '20px' }}>
                {formatFechaEnZona(slotPendiente.inicio, { weekday: 'long', day: 'numeric', month: 'long' })}
                <br />
                {formatHora(slotPendiente.inicio)} – {formatHora(slotPendiente.fin)}
              </p>

              {maxInvitados > 0 && (
                <div className="ek-form-field" style={{ marginBottom: '1rem' }}>
                  <label className="ek-label">
                    Invitados ({invitados} de {maxInvitados} disponibles)
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => setInvitados(Math.max(0, invitados - 1))}
                      disabled={invitados === 0}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
                    >
                      −
                    </button>
                    <span style={{
                      fontSize: '1.5rem',
                      fontWeight: 700,
                      minWidth: '40px',
                      textAlign: 'center'
                    }}>
                      {invitados}
                    </span>
                    <button
                      type="button"
                      onClick={() => setInvitados(Math.min(maxInvitados, invitados + 1))}
                      disabled={invitados === maxInvitados}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
                    >
                      +
                    </button>
                  </div>
                  <p className="ek-helper-text">
                    Total de personas en la grabación: {1 + invitados + invitadosExtra}
                  </p>
                </div>
              )}

              {/* Invitados EXTRA (de pago): se cobran con Stripe en la app. */}
              {permiteExtras && (
                <div className="ek-form-field" style={{ marginBottom: '1rem' }}>
                  <label className="ek-label">
                    Invitados extra (${precioExtraPesos.toLocaleString('es-MX')} c/u)
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => setInvitadosExtra(Math.max(0, invitadosExtra - 1))}
                      disabled={invitadosExtra === 0}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
                    >
                      −
                    </button>
                    <span style={{ fontSize: '1.5rem', fontWeight: 700, minWidth: '40px', textAlign: 'center' }}>
                      {invitadosExtra}
                    </span>
                    <button
                      type="button"
                      onClick={() => setInvitadosExtra(Math.min(maxExtraEstudio, invitadosExtra + 1))}
                      disabled={invitadosExtra === maxExtraEstudio}
                      className="ek-cta ek-cta--secondary"
                      style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
                    >
                      +
                    </button>
                  </div>
                  <p className="ek-helper-text">
                    {invitadosExtra > 0
                      ? `Pagas $${(precioExtraPesos * invitadosExtra).toLocaleString('es-MX')} al confirmar (con tu tarjeta).`
                      : 'Personas arriba de las incluidas en tu plan. Se pagan al confirmar.'}
                  </p>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => setSlotPendiente(null)}
                  disabled={submitting}
                  className="ek-cta ek-cta--secondary"
                  style={{ flex: 1 }}
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmarReserva}
                  disabled={submitting}
                  className="ek-cta"
                  style={{ flex: 1 }}
                >
                  {submitting ? 'Reservando…' : 'Confirmar'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pago de invitados extra (Stripe, tarjeta guardada) tras reservar. */}
      {/* Pago por hora: confirmar → pagar el paquete → esperar acreditación → reservar */}
      {comprarPara && recursoSel && !pagando && !activando && (
        <div className="ek-modal-backdrop" onClick={() => setComprarPara(null)}>
          <div className="ek-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pagar esta hora">
            <div className="ek-modal-handle" />
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>PAGAR ESTA HORA</p>
            <h3 className="ek-display-md" style={{ marginBottom: '8px' }}>{recursoSel.nombre}</h3>
            <p className="ek-body-muted" style={{ marginBottom: '16px' }}>
              {formatFechaEnZona(comprarPara.slot.inicio, { weekday: 'long', day: 'numeric', month: 'long' })}
              <br />
              {formatHora(comprarPara.slot.inicio)} – {formatHora(comprarPara.slot.fin)}
            </p>
            <div className="ek-card ek-card--md" style={{ marginBottom: '16px' }}>
              <p style={{ margin: 0, fontWeight: 600 }}>
                {comprarPara.plan.nombre} · ${Math.round(comprarPara.plan.precio_centavos / 100).toLocaleString('es-MX')}
              </p>
              <p className="ek-body-faint" style={{ margin: '4px 0 0' }}>
                {tienePlan
                  ? `Te faltan créditos para este estudio (cuesta ${costoCreditos(recursoSel)}). Con este paquete te alcanza y la hora queda reservada al pagar.`
                  : `Sin membresía. Con este paquete (${comprarPara.plan.clases_incluidas ?? 1} ${comprarPara.plan.clases_incluidas === 1 ? 'crédito' : 'créditos'}) reservas esta hora al momento de pagar.`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={() => setComprarPara(null)}>
                Cancelar
              </button>
              <button type="button" className="ek-cta ek-cta--gold" style={{ flex: 1 }} onClick={() => setPagando(true)}>
                Pagar y reservar
              </button>
            </div>
          </div>
        </div>
      )}
      {comprarPara && pagando && (
        <PaymentModal
          tierSlug={comprarPara.plan.slug}
          tierNombre={comprarPara.plan.nombre}
          precio={Math.round(comprarPara.plan.precio_centavos / 100)}
          esPaquete
          onClose={() => { setPagando(false); setComprarPara(null); }}
          onPagado={() => {
            const { slot } = comprarPara;
            setPagando(false);
            setComprarPara(null);
            toast.success('¡Pago recibido! Reservando tu hora en cuanto se acredite…');
            void reservarTrasPago(slot, costoCreditos(recursoSel));
          }}
        />
      )}
      {activando && (
        <div className="ek-modal-backdrop">
          <div className="ek-modal" role="status" aria-live="polite" style={{ textAlign: 'center' }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>RESERVANDO</p>
            <p className="ek-body-muted" style={{ margin: 0 }}>Acreditando tu pago y apartando la hora… no cierres esta pantalla.</p>
          </div>
        </div>
      )}

      {pagarInvitados && (
        <PaymentModal
          precio={precioExtraPesos * pagarInvitados.cantidad}
          titulo="Invitados extra"
          subtitulo={`${pagarInvitados.cantidad} ${pagarInvitados.cantidad === 1 ? 'invitado' : 'invitados'} × $${precioExtraPesos.toLocaleString('es-MX')} = $${(precioExtraPesos * pagarInvitados.cantidad).toLocaleString('es-MX')}`}
          pedirNombre={false}
          fetchIntent={() => crearPagoInvitados(pagarInvitados.reservaId, pagarInvitados.cantidad)}
          onClose={() => { const id = pagarInvitados.reservaId; setPagarInvitados(null); navigate(`/app/qr/${id}?nueva=1`); }}
          onPagado={() => { const id = pagarInvitados.reservaId; setPagarInvitados(null); toast.success('¡Invitados extra pagados!'); navigate(`/app/qr/${id}?nueva=1`); }}
        />
      )}
    </div>
  );
}
