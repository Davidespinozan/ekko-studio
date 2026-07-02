import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Star, CalendarX } from 'lucide-react';
import { EmptyState } from '@shared/components/EmptyState';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { celebrar } from '@shared/lib/celebrar';
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
  type TenantReservaConfig,
  type Slot
} from '../logic/reservaLogic';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

function tierTieneAcceso(recurso: Recurso, tier: string | null | undefined): boolean {
  return tier ? recurso.tiers_permitidos.includes(tier) : false;
}

export default function Reservar() {
  const tenant = useTenant();
  const { usuario } = useAuth();
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

  const tier = usuario?.membresia_tier ?? null;
  const puedeUsar = (r: Recurso) => tierTieneAcceso(r, tier);

  const fechas = useMemo(() => generarFechasReservables(config), [config]);

  const [recursoSel, setRecursoSel] = useState<Recurso | null>(null);
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotPendiente, setSlotPendiente] = useState<Slot | null>(null);
  const [invitados, setInvitados] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const maxInvitados = usuario?.membresia_tier === 'pro' ? 4 :
                       usuario?.membresia_tier === 'basica' ? 2 : 0;

  // Resetear invitados cuando se abre/cierra el modal
  useEffect(() => {
    if (!slotPendiente) setInvitados(0);
  }, [slotPendiente]);

  // Auto-seleccionar primer recurso accesible (o el del query param ?recurso=slug)
  useEffect(() => {
    if (recursoSel || recursos.length === 0) return;

    if (recursoSlugParam) {
      const found = recursos.find((r) => r.slug === recursoSlugParam);
      if (found && tierTieneAcceso(found, tier)) {
        setRecursoSel(found);
        return;
      }
    }

    const primerAccesible = recursos.find((r) => tierTieneAcceso(r, tier));
    if (primerAccesible) setRecursoSel(primerAccesible);
  }, [recursos, recursoSel, recursoSlugParam, tier]);

  // Recargar slots cuando cambia recurso o fecha
  useEffect(() => {
    if (!recursoSel || !fechaSel || !usuario) return;

    let mounted = true;
    setLoadingSlots(true);

    const fechaInicio = new Date(fechaSel + 'T00:00:00');
    const fechaFin = new Date(fechaSel + 'T23:59:59');

    Promise.all([
      fetchReservasDelRecurso(recursoSel.id, fechaInicio, fechaFin),
      fetchReservasDelUsuario(usuario.id, fechaInicio, fechaFin)
    ]).then(([reservasRecurso, reservasUsuario]) => {
      if (!mounted) return;
      const generados = generarSlotsDisponibles(
        recursoSel,
        fechaSel,
        config,
        reservasRecurso,
        reservasUsuario
      );
      setSlots(generados);
      setLoadingSlots(false);
    });

    return () => { mounted = false; };
  }, [recursoSel, fechaSel, usuario, config]);

  async function confirmarReserva() {
    if (!slotPendiente || !recursoSel) return;
    setSubmitting(true);
    try {
      await crearReserva({
        recursoId: recursoSel.id,
        slotInicio: slotPendiente.inicio,
        duracionMin: config.duracion_default_min,
        invitados,
        notas: undefined
      });
      setSlotPendiente(null);
      setSubmitting(false);
      const fechaFmt = slotPendiente.inicio.toLocaleDateString('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      });
      const horaFmt = formatHora(slotPendiente.inicio);
      celebrar();
      toast.success(`Reserva confirmada · ${fechaFmt}, ${horaFmt}`);
      navigate('/app');
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'No se pudo crear la reserva';
      toast.error(raw + ' · Intentalo otra vez');
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
          hint="No hay estudios activos en este momento. Contacta al administrador."
        />
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar">RESERVAR</p>
          <h1 className="ek-h2">Elige tu sesión</h1>
        </div>

        {/* Selector de recurso */}
        <div className="ek-stack-sm">
          <label className="ek-field-label">Estudio</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {recursos.map((r) => {
              const activo = recursoSel?.id === r.id;
              const accesible = puedeUsar(r);
              const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
              return (
                <button
                  key={r.id}
                  className={`ek-chip ${activo && accesible ? 'ek-chip--active' : ''}`}
                  style={accesible ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}
                  onClick={() => {
                    if (!accesible) {
                      toast.warning('Tu plan no incluye este estudio. Ve a Estudios para más info.');
                      return;
                    }
                    setRecursoSel(r);
                  }}
                >
                  {r.nombre}
                  {esPro && !accesible && (
                    <span style={{
                      fontSize: '9px',
                      color: 'var(--ek-mustard)',
                      fontWeight: 700,
                      letterSpacing: '0.12em',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '3px'
                    }}><Star size={9} fill="currentColor" aria-hidden="true" /> PRO</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selector de fecha */}
        <div className="ek-stack-sm">
          <label className="ek-field-label">Fecha</label>
          <div className="ek-hscroll-fade">
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                overflowX: 'auto',
                paddingBottom: '0.5rem',
                scrollbarWidth: 'thin',
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
          ) : slots.length === 0 ? (
            <p className="ek-body-muted">
              El estudio no opera este día.
            </p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {slots.map((slot, i) => {
                const tooltip = slot.disponible
                  ? undefined
                  : slot.razon === 'pasado' ? 'Ya pasó'
                  : slot.razon === 'ocupado' ? 'Ya reservado'
                  : slot.razon === 'continuo' ? 'No puedes reservar continuas'
                  : slot.razon === 'anticipacion_insuficiente' ? 'Anticipación insuficiente'
                  : 'No disponible';

                return (
                  <button
                    key={i}
                    className="ek-slot"
                    disabled={!slot.disponible}
                    onClick={() => setSlotPendiente(slot)}
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
                {slotPendiente.inicio.toLocaleDateString('es-MX', {
                  weekday: 'long', day: 'numeric', month: 'long'
                })}
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
                    Total de personas en la grabación: {1 + invitados}
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
    </div>
  );
}
