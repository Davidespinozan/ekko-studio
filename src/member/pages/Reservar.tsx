import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import {
  useRecursosDelTenant,
  fetchReservasDelRecurso,
  fetchReservasDelUsuario,
  crearReserva
} from '../hooks/useReservas';
import {
  generarSlotsDisponibles,
  generarFechasReservables,
  filtrarRecursosPorTier,
  formatHora,
  type TenantReservaConfig,
  type Slot
} from '../logic/reservaLogic';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Reservar() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const navigate = useNavigate();
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

  const recursosVisibles = useMemo(
    () => filtrarRecursosPorTier(recursos, usuario?.membresia_tier ?? null),
    [recursos, usuario?.membresia_tier]
  );

  const fechas = useMemo(() => generarFechasReservables(config), [config]);

  const [recursoSel, setRecursoSel] = useState<Recurso | null>(null);
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotPendiente, setSlotPendiente] = useState<Slot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-seleccionar primer recurso disponible
  useEffect(() => {
    if (!recursoSel && recursosVisibles.length > 0) {
      setRecursoSel(recursosVisibles[0]);
    }
  }, [recursosVisibles, recursoSel]);

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
    setError(null);
    const { error: rpcError } = await crearReserva({
      recurso_id: recursoSel.id,
      slot_inicio: slotPendiente.inicio
    });
    if (rpcError) {
      setError(rpcError);
      setSubmitting(false);
      return;
    }
    setSlotPendiente(null);
    setSubmitting(false);
    navigate('/app/historial');
  }

  if (loadingRecursos) {
    return <div className="ek-container"><p className="ek-body">Cargando estudios…</p></div>;
  }

  if (recursosVisibles.length === 0) {
    return (
      <div className="ek-container">
        <div className="ek-stack-lg">
          <p className="ek-eyebrow">SIN ESTUDIOS DISPONIBLES</p>
          <p className="ek-body">
            Tu plan actual no incluye acceso a ningún estudio. Contacta al administrador.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">RESERVAR</p>
          <h1 className="ek-h2">Elige tu sesión</h1>
        </div>

        {/* Selector de recurso */}
        <div className="ek-stack-sm">
          <label className="ek-label">Estudio</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {recursosVisibles.map((r) => (
              <button
                key={r.id}
                onClick={() => setRecursoSel(r)}
                style={{
                  padding: '0.75rem 1rem',
                  minHeight: '44px',
                  background: recursoSel?.id === r.id ? 'var(--ek-black)' : 'transparent',
                  color: recursoSel?.id === r.id ? 'var(--ek-cream)' : 'var(--ek-black)',
                  border: '1.5px solid var(--ek-black)',
                  borderRadius: 'var(--ek-radius-pill)',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: 'pointer'
                }}
              >
                {r.nombre}
              </button>
            ))}
          </div>
        </div>

        {/* Selector de fecha */}
        <div className="ek-stack-sm">
          <label className="ek-label">Fecha</label>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              overflowX: 'auto',
              paddingBottom: '0.5rem',
              scrollbarWidth: 'thin'
            }}
          >
            {fechas.slice(0, 14).map((f) => (
              <button
                key={f.fechaISO}
                onClick={() => setFechaSel(f.fechaISO)}
                style={{
                  flexShrink: 0,
                  padding: '0.625rem 0.875rem',
                  minHeight: '44px',
                  background: fechaSel === f.fechaISO ? 'var(--ek-black)' : 'var(--ek-cream-warm)',
                  color: fechaSel === f.fechaISO ? 'var(--ek-cream)' : 'var(--ek-black)',
                  border: '1px solid var(--ek-line)',
                  borderRadius: 'var(--ek-radius)',
                  fontWeight: 600,
                  fontSize: '0.8125rem',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Grid de slots */}
        <div className="ek-stack-sm">
          <label className="ek-label">Horario</label>
          {loadingSlots ? (
            <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.875rem' }}>Cargando horarios…</p>
          ) : slots.length === 0 ? (
            <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.875rem' }}>
              El estudio no opera este día.
            </p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))', gap: '0.5rem' }}>
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
                    disabled={!slot.disponible}
                    onClick={() => setSlotPendiente(slot)}
                    title={tooltip}
                    style={{
                      padding: '0.875rem 0.5rem',
                      minHeight: '52px',
                      background: slot.disponible ? 'var(--ek-cream-warm)' : 'transparent',
                      color: slot.disponible ? 'var(--ek-black)' : 'var(--ek-ink-muted)',
                      border: '1px solid var(--ek-line)',
                      borderRadius: 'var(--ek-radius)',
                      fontFamily: 'var(--ek-font-mono)',
                      fontSize: '0.9375rem',
                      fontWeight: 600,
                      cursor: slot.disponible ? 'pointer' : 'not-allowed',
                      opacity: slot.disponible ? 1 : 0.4
                    }}
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
            onClick={() => !submitting && setSlotPendiente(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '1rem', zIndex: 100
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--ek-cream)',
                borderRadius: 'var(--ek-radius-lg)',
                padding: '1.5rem',
                maxWidth: '420px', width: '100%'
              }}
            >
              <p className="ek-eyebrow" style={{ marginBottom: '0.5rem' }}>CONFIRMAR RESERVA</p>
              <h3 className="ek-h3" style={{ marginBottom: '0.75rem' }}>{recursoSel.nombre}</h3>
              <p style={{ color: 'var(--ek-ink-muted)', fontSize: '0.9375rem', marginBottom: '1.5rem' }}>
                {slotPendiente.inicio.toLocaleDateString('es-MX', {
                  weekday: 'long', day: 'numeric', month: 'long'
                })}
                <br />
                {formatHora(slotPendiente.inicio)} – {formatHora(slotPendiente.fin)}
              </p>

              {error && (
                <p className="ek-error-text" style={{ marginBottom: '1rem' }}>{error}</p>
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
