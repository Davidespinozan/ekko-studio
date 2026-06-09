import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import {
  useRecursosDelTenant,
  fetchReservasDelRecurso,
  fetchReservasDelUsuario
} from '@member/hooks/useReservas';
import {
  generarSlotsDisponibles,
  generarFechasReservables,
  filtrarRecursosPorTier,
  formatHora,
  type TenantReservaConfig,
  type Slot
} from '@member/logic/reservaLogic';
import type { Database } from '@shared/types/database';
import { traducirErrorReserva } from '../lib/traducirErrorReserva';
import { reprogramarReserva } from '../lib/reprogramarReserva';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface MiembroParaReserva {
  id: string;
  nombre: string;
  membresia_tier: string | null;
}

/** Reserva existente que se está reprogramando (Sprint RP-3b). */
export interface ReservaOriginal {
  id: string;
  recurso_id: string;
  recurso_nombre: string;
  slot_inicio: string; // ISO
  slot_fin: string; // ISO
}

interface Props {
  miembro: MiembroParaReserva;
  onClose: () => void;
  onCreada: () => void;
  /** Si se pasa, el modal opera en modo "reprogramar" (RP-3b): el flujo
   *  de selección es el mismo, pero al confirmar orquesta crear + cancelar. */
  reprogramarDe?: ReservaOriginal;
}

function fechaHoraCorta(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Quita UNA reserva de la lista por coincidencia de `slot_inicio`. Se usa
 * en modo reprogramar para sacar la reserva vieja de las listas que
 * alimentan la grilla — si no, su propio slot saldría 'ocupado' y los
 * contiguos 'continuo', y recepción no podría moverla a ±1 slot.
 */
function quitarReservaPorSlot<T extends { slot_inicio: string }>(
  lista: T[],
  slotInicioISO: string
): T[] {
  const objetivo = new Date(slotInicioISO).getTime();
  const idx = lista.findIndex((r) => new Date(r.slot_inicio).getTime() === objetivo);
  return idx === -1 ? lista : [...lista.slice(0, idx), ...lista.slice(idx + 1)];
}

/**
 * Crear una reserva PARA un miembro desde recepción (Sprint RP-3a) y
 * reprogramar una reserva existente (Sprint RP-3b, prop `reprogramarDe`).
 *
 * Reusa la lógica de slots del módulo miembro (`reservaLogic`). La
 * diferencia clave (D1): recepción reserva walk-ins → se construye el
 * config con `anticipacion_min_horas: 0`, así `generarSlotsDisponibles`
 * no marca los horarios cercanos como no disponibles.
 */
export function CrearReservaModal({ miembro, onClose, onCreada, reprogramarDe }: Props) {
  const tenant = useTenant();
  const toast = useToast();
  const { recursos, isLoading: loadingRecursos } = useRecursosDelTenant();
  const esReprogramar = reprogramarDe != null;

  // Config del tenant — anticipación a 0 para no esconder walk-ins (D1).
  const config = useMemo<TenantReservaConfig>(() => {
    const c = (tenant.config as Record<string, unknown>)?.reserva as
      | Record<string, unknown>
      | undefined ?? {};
    return {
      duracion_default_min: Number(c.duracion_default_min ?? 60),
      cupos_por_recurso: Number(c.cupos_por_recurso ?? 1),
      permitir_continuas: Boolean(c.permitir_continuas ?? false),
      anticipacion_min_horas: 0,
      anticipacion_max_dias: Number(c.anticipacion_max_dias ?? 30),
      ventana_check_in_min: Number(c.ventana_check_in_min ?? 15)
    };
  }, [tenant.config]);

  const fechas = useMemo(() => generarFechasReservables(config), [config]);
  const recursosAccesibles = useMemo(
    () => filtrarRecursosPorTier(recursos, miembro.membresia_tier),
    [recursos, miembro.membresia_tier]
  );

  const [recursoSel, setRecursoSel] = useState<Recurso | null>(null);
  const [fechaSel, setFechaSel] = useState<string>(fechas[0]?.fechaISO ?? '');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotSel, setSlotSel] = useState<Slot | null>(null);
  const [notas, setNotas] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Auto-seleccionar el recurso inicial. En modo reprogramar, el de la
  // reserva original (recepción puede cambiarlo).
  useEffect(() => {
    if (recursoSel || recursosAccesibles.length === 0) return;
    const inicial = reprogramarDe
      ? recursosAccesibles.find((r) => r.id === reprogramarDe.recurso_id) ?? recursosAccesibles[0]
      : recursosAccesibles[0];
    setRecursoSel(inicial);
  }, [recursosAccesibles, recursoSel, reprogramarDe]);

  // Recargar slots al cambiar recurso o fecha.
  useEffect(() => {
    if (!recursoSel || !fechaSel) return;
    let mounted = true;
    setLoadingSlots(true);
    setSlotSel(null);

    const fechaInicio = new Date(fechaSel + 'T00:00:00');
    const fechaFin = new Date(fechaSel + 'T23:59:59');

    Promise.all([
      fetchReservasDelRecurso(recursoSel.id, fechaInicio, fechaFin),
      fetchReservasDelUsuario(miembro.id, fechaInicio, fechaFin)
    ]).then(([reservasRecurso, reservasMiembro]) => {
      if (!mounted) return;
      let resRecurso = reservasRecurso;
      let resMiembro = reservasMiembro;
      // Reprogramar: sacar la reserva vieja de la grilla para que su slot
      // y los contiguos vuelvan a ofrecerse.
      if (reprogramarDe) {
        resMiembro = quitarReservaPorSlot(resMiembro, reprogramarDe.slot_inicio);
        if (recursoSel.id === reprogramarDe.recurso_id) {
          resRecurso = quitarReservaPorSlot(resRecurso, reprogramarDe.slot_inicio);
        }
      }
      setSlots(
        generarSlotsDisponibles(recursoSel, fechaSel, config, resRecurso, resMiembro)
      );
      setLoadingSlots(false);
    });

    return () => {
      mounted = false;
    };
  }, [recursoSel, fechaSel, config, miembro.id, reprogramarDe]);

  async function handleConfirmar() {
    if (!recursoSel || !slotSel || submitting) return;
    setSubmitting(true);

    // ---- Modo reprogramar (RP-3b): orquesta crear + cancelar. ----
    if (reprogramarDe) {
      const mismoSlot =
        recursoSel.id === reprogramarDe.recurso_id &&
        slotSel.inicio.getTime() === new Date(reprogramarDe.slot_inicio).getTime();
      if (mismoSlot) {
        toast.error('Ese es el horario actual de la reserva. Elegí uno distinto.');
        setSubmitting(false);
        return;
      }

      const resultado = await reprogramarReserva({
        reservaOriginalId: reprogramarDe.id,
        usuarioId: miembro.id,
        original: {
          recursoId: reprogramarDe.recurso_id,
          inicio: new Date(reprogramarDe.slot_inicio),
          fin: new Date(reprogramarDe.slot_fin)
        },
        nuevo: {
          recursoId: recursoSel.id,
          slotInicio: slotSel.inicio,
          duracionMin: config.duracion_default_min,
          notas: notas.trim() || null
        }
      });

      if (resultado.estado === 'ok') {
        toast.success(resultado.mensaje);
        onCreada();
        onClose();
      } else if (resultado.estado === 'error_crear' || resultado.estado === 'error_cancelar') {
        // Nada cambió — la reserva original sigue en pie. El modal queda
        // abierto para reintentar con otro horario.
        toast.error(resultado.mensaje);
        setSubmitting(false);
      } else {
        // Fallo parcial: refrescar el perfil para reflejar la realidad y
        // cerrar. El toast lleva la instrucción — nunca en silencio.
        toast.error(resultado.mensaje);
        onCreada();
        onClose();
      }
      return;
    }

    // ---- Modo crear (RP-3a). ----
    // Cast a `any`: reservar_para_miembro_atomic es un RPC nuevo (RP-1) que
    // todavía no está en los tipos generados de Supabase. Mismo patrón que
    // `crearReserva` en useReservas.ts.
    const { error } = await (supabase.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>
    ) => Promise<{ error: { message: string } | null }>)('reservar_para_miembro_atomic', {
      p_usuario_id: miembro.id,
      p_recurso_id: recursoSel.id,
      p_slot_inicio: slotSel.inicio.toISOString(),
      p_duracion_min: config.duracion_default_min,
      p_invitados: 0,
      p_notas: notas.trim() || null
    });

    if (error) {
      toast.error(traducirErrorReserva(error.message));
      setSubmitting(false);
      return;
    }

    toast.success(
      `Reserva creada para ${miembro.nombre} · ${formatHora(slotSel.inicio)}`
    );
    onCreada();
    onClose();
  }

  return (
    <div
      onClick={() => !submitting && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={esReprogramar ? 'Reprogramar reserva' : 'Crear reserva'}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--ek-backdrop)',
        backdropFilter: 'blur(var(--ek-backdrop-blur))',
        WebkitBackdropFilter: 'blur(var(--ek-backdrop-blur))',
        zIndex: 110,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        animation: 'ek-fade-in 0.18s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-card)',
          maxWidth: '480px',
          width: '100%',
          maxHeight: '92dvh',
          overflowY: 'auto',
          padding: 'clamp(16px, 5vw, 28px)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>
          {esReprogramar ? 'REPROGRAMAR RESERVA' : 'CREAR RESERVA'}
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            margin: 0,
            marginBottom: esReprogramar ? '12px' : '16px',
            letterSpacing: '-0.02em'
          }}
        >
          Para {miembro.nombre}
        </h3>

        {reprogramarDe && (
          <div
            style={{
              background: 'var(--ek-bg-elevated)',
              border: '0.5px solid var(--ek-line)',
              borderRadius: 'var(--ek-r-md)',
              padding: '10px 14px',
              marginBottom: '16px'
            }}
          >
            <p
              style={{
                fontSize: '10px',
                letterSpacing: '0.1em',
                fontWeight: 700,
                color: 'var(--ek-ink-faint)',
                margin: 0,
                marginBottom: '3px'
              }}
            >
              MOVIENDO ESTA RESERVA
            </p>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
              {reprogramarDe.recurso_nombre} · {fechaHoraCorta(reprogramarDe.slot_inicio)}
            </p>
          </div>
        )}

        {loadingRecursos ? (
          <div className="ek-skeleton" style={{ height: '120px', borderRadius: 'var(--ek-r-md)' }} />
        ) : recursosAccesibles.length === 0 ? (
          <p className="ek-body-muted">
            El plan del miembro no tiene acceso a ningún estudio activo.
          </p>
        ) : (
          <>
            {/* Recurso */}
            <label className="ek-label" style={{ marginBottom: '6px', display: 'block' }}>
              Estudio
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px' }}>
              {recursosAccesibles.map((r) => {
                const activo = recursoSel?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRecursoSel(r)}
                    style={{
                      minHeight: '44px',
                      padding: '8px 14px',
                      borderRadius: 'var(--ek-r-pill)',
                      border: `0.5px solid ${activo ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                      background: activo ? 'var(--ek-mustard-soft)' : 'transparent',
                      color: activo ? 'var(--ek-mustard)' : 'var(--ek-ink-muted)',
                      fontSize: '13px',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    {r.nombre}
                  </button>
                );
              })}
            </div>

            {/* Fecha */}
            <label className="ek-label" style={{ marginBottom: '6px', display: 'block' }}>
              Fecha
            </label>
            <div className="ek-hscroll-fade" style={{ marginBottom: '16px' }}>
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  overflowX: 'auto',
                  paddingBottom: '6px',
                  scrollSnapType: 'x proximity'
                }}
              >
                {fechas.slice(0, 14).map((f) => {
                  const activo = fechaSel === f.fechaISO;
                  return (
                    <button
                      key={f.fechaISO}
                      type="button"
                      onClick={() => setFechaSel(f.fechaISO)}
                      style={{
                        flexShrink: 0,
                        scrollSnapAlign: 'start',
                        minHeight: '44px',
                        padding: '8px 12px',
                        borderRadius: 'var(--ek-r-sm)',
                        border: `0.5px solid ${activo ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                        background: activo ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-elevated)',
                        color: activo ? 'var(--ek-mustard)' : 'var(--ek-ink)',
                        fontSize: '12px',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        cursor: 'pointer'
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Slots */}
            <label className="ek-label" style={{ marginBottom: '6px', display: 'block' }}>
              Horario
            </label>
            {loadingSlots ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="ek-skeleton"
                    style={{ height: '48px', borderRadius: 'var(--ek-r-sm)' }}
                  />
                ))}
              </div>
            ) : slots.length === 0 ? (
              <p className="ek-body-muted">El estudio no opera este día.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                {slots.map((slot, i) => {
                  const sel = slotSel?.inicio.getTime() === slot.inicio.getTime();
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={!slot.disponible}
                      onClick={() => setSlotSel(slot)}
                      style={{
                        minHeight: '48px',
                        padding: '12px 4px',
                        borderRadius: 'var(--ek-r-sm)',
                        border: `0.5px solid ${sel ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                        background: sel
                          ? 'var(--ek-mustard-soft)'
                          : slot.disponible ? 'var(--ek-bg-elevated)' : 'transparent',
                        color: sel
                          ? 'var(--ek-mustard)'
                          : slot.disponible ? 'var(--ek-ink)' : 'var(--ek-ink-faint)',
                        fontFamily: 'var(--ek-font-mono)',
                        fontSize: '14px',
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

            {/* Notas + confirmar */}
            <div className="ek-form-field" style={{ marginTop: '16px' }}>
              <label className="ek-label">Notas (opcional)</label>
              <input
                type="text"
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                className="ek-input"
                placeholder="Ej. walk-in, pagó en mostrador"
                maxLength={200}
                disabled={submitting}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1, minHeight: '44px' }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmar}
                disabled={submitting || !recursoSel || !slotSel}
                className="ek-cta"
                style={{ flex: 1, minHeight: '44px', opacity: submitting || !slotSel ? 0.5 : 1 }}
              >
                {esReprogramar
                  ? submitting ? 'Reprogramando…' : 'Reprogramar'
                  : submitting ? 'Creando…' : 'Crear reserva'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
