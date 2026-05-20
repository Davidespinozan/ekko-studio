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

type Recurso = Database['public']['Tables']['recursos']['Row'];

export interface MiembroParaReserva {
  id: string;
  nombre: string;
  membresia_tier: string | null;
}

interface Props {
  miembro: MiembroParaReserva;
  onClose: () => void;
  onCreada: () => void;
}

/**
 * Crear una reserva PARA un miembro desde recepción (Sprint RP-3a).
 *
 * Reusa la lógica de slots del módulo miembro (`reservaLogic`). La
 * diferencia clave (D1): recepción reserva walk-ins → se construye el
 * config con `anticipacion_min_horas: 0`, así `generarSlotsDisponibles`
 * no marca los horarios cercanos como no disponibles. El RPC
 * `reservar_para_miembro_atomic` ya permite saltar la anticipación.
 */
export function CrearReservaModal({ miembro, onClose, onCreada }: Props) {
  const tenant = useTenant();
  const toast = useToast();
  const { recursos, isLoading: loadingRecursos } = useRecursosDelTenant();

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

  // Auto-seleccionar el primer recurso accesible.
  useEffect(() => {
    if (!recursoSel && recursosAccesibles.length > 0) {
      setRecursoSel(recursosAccesibles[0]);
    }
  }, [recursosAccesibles, recursoSel]);

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
      setSlots(
        generarSlotsDisponibles(recursoSel, fechaSel, config, reservasRecurso, reservasMiembro)
      );
      setLoadingSlots(false);
    });

    return () => {
      mounted = false;
    };
  }, [recursoSel, fechaSel, config, miembro.id]);

  async function handleConfirmar() {
    if (!recursoSel || !slotSel || submitting) return;
    setSubmitting(true);

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
      aria-label="Crear reserva"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
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
          maxHeight: '92vh',
          overflowY: 'auto',
          padding: 'clamp(16px, 5vw, 28px)',
          animation: 'ek-scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>
          CREAR RESERVA
        </p>
        <h3
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            margin: 0,
            marginBottom: '16px',
            letterSpacing: '-0.02em'
          }}
        >
          Para {miembro.nombre}
        </h3>

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
                {submitting ? 'Creando…' : 'Crear reserva'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
