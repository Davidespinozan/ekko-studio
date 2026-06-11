import { useEffect, useMemo, useState } from 'react';
import { X, CheckCircle2, Search, CalendarDays } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { StatusBadge } from '@shared/components/StatusBadge';
import { EmptyState } from '@shared/components/EmptyState';
import { useReservasHoy, checkInManual, type ReservaConJoin } from '../hooks/useReservasHoy';
import { playCheckInSuccess, playCheckInError } from '../lib/checkInFeedback';

interface Props {
  onManualCheckInSuccess?: (data: any) => void;
  /** Pausa el polling de la lista (ej. mientras hay un modal de
   *  check-in abierto a nivel Scanner). */
  pausarPolling?: boolean;
}

interface RecursoOption {
  id: string;
  nombre: string;
}

const FILTRO_RECURSO_KEY = 'ekko-recepcion-filtro-recurso';

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Etiquetas cortas para el badge de estado, en clave operativa de recepción.
 * `confirmada` se muestra como "PENDIENTE" (aún no llegó / falta check-in),
 * pill mostaza propia; el resto delega en <StatusBadge/> (icono + tono).
 * `cancelada` y `cancelada_admin` comparten visual: recepción no necesita
 * diferenciar quién canceló.
 */
const STATUS_LABEL_CORTO: Record<string, string> = {
  completada: 'OK',
  cancelada: 'CANCELADA',
  cancelada_admin: 'CANCELADA',
  no_show: 'NO SHOW'
};

/**
 * Badge de estado de reserva. `confirmada` → pill mostaza "PENDIENTE"
 * (operativo). Estados terminales → <StatusBadge/> unificado. Estado no
 * mapeado: se loguea para forzar el fix del frontend.
 */
function StatusReservaBadge({ status }: { status: string }) {
  if (status === 'confirmada') {
    return (
      <span
        className="ek-badge"
        style={{
          backgroundColor: 'var(--ek-mustard)',
          color: 'var(--ek-bg)',
          fontSize: '10px',
          fontWeight: 700,
          flexShrink: 0
        }}
      >
        PENDIENTE
      </span>
    );
  }
  if (status in STATUS_LABEL_CORTO) {
    return <StatusBadge status={status} label={STATUS_LABEL_CORTO[status]} size={12} />;
  }
  if (typeof console !== 'undefined') {
    console.error('[ReservasHoyView] Status no mapeado:', status);
  }
  return <StatusBadge status={status} label={status.toUpperCase()} size={12} />;
}

function capitalizarNombre(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatearDia(fecha: Date): string {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const target = new Date(fecha);
  target.setHours(0, 0, 0, 0);

  const diffDias = Math.round((target.getTime() - hoy.getTime()) / 86400000);

  if (diffDias === 0) return 'Hoy';
  if (diffDias === 1) return 'Mañana';
  if (diffDias === -1) return 'Ayer';

  return target.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'short'
  });
}

export function ReservasHoyView({ onManualCheckInSuccess, pausarPolling = false }: Props = {}) {
  const tenant = useTenant();
  const [fechaSeleccionada, setFechaSeleccionada] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [selected, setSelected] = useState<ReservaConJoin | null>(null);
  // Polling pausa si hay un modal de check-in abierto (manual local o
  // CheckInDetail a nivel Scanner) — evita reordenar la lista debajo.
  const { reservas, isLoading, refetch } = useReservasHoy(
    fechaSeleccionada,
    !selected && !pausarPolling
  );

  // Búsqueda + debounce
  const [busqueda, setBusqueda] = useState('');
  const [busquedaDebounced, setBusquedaDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setBusquedaDebounced(busqueda.trim()), 200);
    return () => clearTimeout(t);
  }, [busqueda]);

  // Filtro por recurso (persistido en localStorage)
  const [recursoFiltrado, setRecursoFiltrado] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return 'todos';
    return localStorage.getItem(FILTRO_RECURSO_KEY) ?? 'todos';
  });
  useEffect(() => {
    try {
      localStorage.setItem(FILTRO_RECURSO_KEY, recursoFiltrado);
    } catch {
      // ignore quota errors
    }
  }, [recursoFiltrado]);

  // Cargar recursos del tenant (solo activos)
  const [recursos, setRecursos] = useState<RecursoOption[]>([]);
  useEffect(() => {
    let mounted = true;
    void supabase
      .from('recursos')
      .select('id, nombre')
      .eq('tenant_id', tenant.id)
      .eq('activo', true)
      .order('nombre', { ascending: true })
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          console.error('[ReservasHoyView] recursos:', error);
          return;
        }
        setRecursos(data ?? []);
      });
    return () => {
      mounted = false;
    };
  }, [tenant.id]);

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const esHoy = fechaSeleccionada.getTime() === hoy.getTime();

  const cambiarDia = (delta: number) => {
    const nueva = new Date(fechaSeleccionada);
    nueva.setDate(nueva.getDate() + delta);
    setFechaSeleccionada(nueva);
  };

  // Filtros combinados (recurso + búsqueda)
  const reservasFiltradas = useMemo(() => {
    let result = reservas;

    if (recursoFiltrado !== 'todos') {
      result = result.filter((r) => r.recurso?.id === recursoFiltrado);
    }

    if (busquedaDebounced) {
      const q = normalizar(busquedaDebounced);
      result = result.filter((r) => {
        const nombre = normalizar(r.usuario?.nombre ?? '');
        const email = normalizar(r.usuario?.email ?? '');
        const folio = normalizar(r.folio ?? '');
        return nombre.includes(q) || email.includes(q) || folio.includes(q);
      });
    }

    return result;
  }, [reservas, recursoFiltrado, busquedaDebounced]);

  const { llegando, resto, faltantes } = useMemo(() => {
    const now = Date.now();
    const llegando: ReservaConJoin[] = [];
    const resto: ReservaConJoin[] = [];
    const faltantes: ReservaConJoin[] = [];
    reservasFiltradas.forEach((r) => {
      const inicio = new Date(r.slot_inicio).getTime();
      const fin = new Date(r.slot_fin).getTime();
      const enVentana =
        now >= inicio - 15 * 60_000 && (now <= fin || now <= inicio + 15 * 60_000);
      // "Llegando ahora" solo aplica si la fecha vista es hoy.
      if (esHoy && enVentana) {
        llegando.push(r);
      } else if (esHoy && r.status === 'confirmada' && fin < now) {
        // Confirmada cuyo horario ya pasó sin check-in → faltante (candidata
        // a no-show; el cron la resuelve, recepción NO la marca acá — Bloque D).
        faltantes.push(r);
      } else {
        resto.push(r);
      }
    });
    return { llegando, resto, faltantes };
  }, [reservasFiltradas, esHoy]);

  // Ocupación del día (sobre la lista sin filtrar): sesiones activas + check-ins.
  const ocupacion = useMemo(() => {
    const activas = reservas.filter(
      (r) => r.status !== 'cancelada' && r.status !== 'cancelada_admin'
    );
    const conCheckIn = reservas.filter((r) => r.status === 'completada').length;
    return { total: activas.length, conCheckIn };
  }, [reservas]);

  const filtrosActivos = recursoFiltrado !== 'todos' || busquedaDebounced.length > 0;
  const sinResultadosTrasFiltro =
    filtrosActivos && reservas.length > 0 && reservasFiltradas.length === 0;
  const recursoFiltradoNombre =
    recursos.find((r) => r.id === recursoFiltrado)?.nombre ?? '';

  const cargandoInicial = isLoading && reservas.length === 0;

  return (
    <div className="rec-hoy">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px',
          padding: '6px',
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-md)'
        }}
      >
        <button
          onClick={() => cambiarDia(-1)}
          className="ek-icon-btn"
          aria-label="Día anterior"
          style={{ width: '44px', height: '44px', padding: 0 }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div style={{ textAlign: 'center', flex: 1 }}>
          <p className="ek-eyebrow" style={{ marginBottom: '2px', fontSize: '9px' }}>
            VISTA DEL DÍA
          </p>
          <p
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '16px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: 0,
              textTransform: 'capitalize'
            }}
          >
            {formatearDia(fechaSeleccionada)}
          </p>
        </div>

        <button
          onClick={() => cambiarDia(1)}
          className="ek-icon-btn"
          aria-label="Día siguiente"
          style={{ width: '44px', height: '44px', padding: 0 }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Ocupación del día */}
      {!cargandoInicial && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--ek-ink-muted)',
            margin: '0 0 4px',
            textAlign: 'center'
          }}
        >
          {ocupacion.total === 0
            ? 'Sin reservas para este día'
            : `${ocupacion.total} ${ocupacion.total === 1 ? 'sesión' : 'sesiones'} · ${ocupacion.conCheckIn} con check-in`}
        </p>
      )}

      {/* Búsqueda + filtro recurso */}
      <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ position: 'relative' }}>
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar nombre, email o folio…"
            className="ek-input"
            style={{ paddingRight: busqueda ? '52px' : undefined, minHeight: '44px' }}
            aria-label="Buscar reserva"
          />
          {busqueda && (
            <button
              type="button"
              onClick={() => setBusqueda('')}
              aria-label="Limpiar búsqueda"
              style={{
                position: 'absolute',
                top: '50%',
                right: '4px',
                transform: 'translateY(-50%)',
                width: '44px',
                height: '44px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                color: 'var(--ek-ink-muted)',
                cursor: 'pointer',
                lineHeight: 1
              }}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>

        <select
          value={recursoFiltrado}
          onChange={(e) => setRecursoFiltrado(e.target.value)}
          className="ek-input"
          style={{ minHeight: '44px' }}
          aria-label="Filtrar por estudio"
        >
          <option value="todos">Todos los estudios</option>
          {recursos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.nombre}
            </option>
          ))}
        </select>
      </div>

      {/* Pills de filtros activos */}
      {filtrosActivos && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            marginTop: '12px',
            alignItems: 'center'
          }}
        >
          <span
            style={{
              fontSize: '11px',
              color: 'var(--ek-ink-faint)',
              letterSpacing: '0.08em',
              fontWeight: 600
            }}
          >
            FILTROS:
          </span>
          {recursoFiltrado !== 'todos' && (
            <button
              type="button"
              onClick={() => setRecursoFiltrado('todos')}
              className="ek-badge"
              style={{
                background: 'var(--ek-mustard-soft)',
                color: 'var(--ek-mustard)',
                border: '0.5px solid var(--ek-mustard-dim)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '11px',
                minHeight: '44px',
                padding: '0 12px'
              }}
            >
              {recursoFiltradoNombre} <X size={13} aria-hidden="true" />
            </button>
          )}
          {busquedaDebounced && (
            <button
              type="button"
              onClick={() => setBusqueda('')}
              className="ek-badge"
              style={{
                background: 'var(--ek-mustard-soft)',
                color: 'var(--ek-mustard)',
                border: '0.5px solid var(--ek-mustard-dim)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '11px',
                minHeight: '44px',
                padding: '0 12px'
              }}
            >
              &ldquo;{busquedaDebounced}&rdquo; <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* Skeletons durante la carga inicial (no pantalla vacía) */}
      {cargandoInicial ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '24px' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="ek-skeleton"
              style={{ height: '76px', borderRadius: 'var(--ek-r-md)' }}
            />
          ))}
        </div>
      ) : sinResultadosTrasFiltro ? (
        <div style={{ marginTop: '20px' }}>
          <EmptyState
            icon={Search}
            title="Sin coincidencias"
            hint="No hay reservas que coincidan con los filtros."
            tone="neutral"
            action={
              <button
                type="button"
                onClick={() => {
                  setBusqueda('');
                  setRecursoFiltrado('todos');
                }}
                className="ek-icon-btn"
                style={{ width: 'auto', minHeight: '44px', padding: '10px 16px', fontSize: '12px' }}
              >
                Limpiar filtros
              </button>
            }
          />
        </div>
      ) : llegando.length === 0 && resto.length === 0 && faltantes.length === 0 ? (
        <div style={{ marginTop: '24px' }}>
          <EmptyState
            icon={CalendarDays}
            tone="neutral"
            title={esHoy ? 'Sin reservas para hoy' : 'Sin reservas para este día'}
            hint="Cuando haya reservas aparecerán acá. Escaneá el QR del cliente o registrá un walk-in desde su perfil."
          />
        </div>
      ) : (
        <>
          <section style={{ marginBottom: '32px', marginTop: '24px' }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '12px' }}>
              LLEGANDO AHORA
            </p>
            {llegando.length === 0 ? (
              <p className="ek-body-faint" style={{ padding: '12px 0' }}>
                No hay reservas próximas a llegar.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {llegando.map((r) => (
                  <ReservaCard key={r.id} reserva={r} onSelect={setSelected} highlight />
                ))}
              </div>
            )}
          </section>

          <section>
            <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>
              {esHoy ? 'RESTO DEL DÍA' : 'RESERVAS DEL DÍA'}
            </p>
            {resto.length === 0 ? (
              <p className="ek-body-faint" style={{ padding: '12px 0' }}>
                {esHoy ? 'No hay más reservas para este día.' : 'No hay reservas para este día.'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {resto.map((r) => (
                  <ReservaCard key={r.id} reserva={r} onSelect={setSelected} />
                ))}
              </div>
            )}
          </section>

          {esHoy && faltantes.length > 0 && (
            <section style={{ marginTop: '32px' }}>
              <p className="ek-eyebrow" style={{ marginBottom: '8px', color: 'var(--ek-danger)' }}>
                FALTANTES
              </p>
              <p className="ek-body-faint" style={{ margin: '0 0 12px', fontSize: '12px' }}>
                Reservas cuyo horario ya pasó sin check-in. El sistema las marca como
                inasistencia automáticamente.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {faltantes.map((r) => (
                  <ReservaCard key={r.id} reserva={r} onSelect={setSelected} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {selected && (
        <ManualCheckInModal
          reserva={selected}
          onClose={() => setSelected(null)}
          onDone={async (data) => {
            await refetch();
            setSelected(null);
            onManualCheckInSuccess?.(data);
          }}
        />
      )}
    </div>
  );
}

function ReservaCard({
  reserva,
  onSelect,
  highlight
}: {
  reserva: ReservaConJoin;
  onSelect: (r: ReservaConJoin) => void;
  highlight?: boolean;
}) {
  const hora = new Date(reserva.slot_inicio).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const nombreFormat =
    capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';

  const tier = reserva.usuario?.membresia_tier;
  // Disabled si está cancelada (cualquier tipo) o no-show. completada permite
  // abrir el modal (muestra "ya hizo check-in").
  const disabled =
    reserva.status === 'cancelada' ||
    reserva.status === 'cancelada_admin' ||
    reserva.status === 'no_show';

  return (
    <button
      onClick={() => onSelect(reserva)}
      disabled={disabled}
      className="ek-card ek-card-interactive"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '16px 18px',
        textAlign: 'left',
        background: 'var(--ek-bg-soft)',
        border: highlight
          ? '0.5px solid var(--ek-mustard-dim)'
          : '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        font: 'inherit',
        color: 'inherit',
        width: '100%',
        opacity: disabled ? 0.55 : 1,
        boxShadow: highlight ? '0 0 0 1px var(--ek-mustard-dim)' : 'none'
      }}
    >
      <div
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '22px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: 'var(--ek-ink)',
          minWidth: '70px'
        }}
      >
        {hora}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '16px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '4px',
            color: 'var(--ek-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {nombreFormat}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          {reserva.recurso?.nombre ?? '—'}
          {tier && ` · ${tier}`}
        </p>
      </div>

      <StatusReservaBadge status={reserva.status} />
    </button>
  );
}

function ManualCheckInModal({
  reserva,
  onClose,
  onDone
}: {
  reserva: ReservaConJoin;
  onClose: () => void;
  onDone: (data: any) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yaCheckIn = reserva.status === 'completada';

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await checkInManual(reserva.id, motivo.trim() || undefined);
      playCheckInSuccess();
      await onDone(result);
    } catch (e) {
      playCheckInError();
      setError(e instanceof Error ? e.message : 'Error en check-in');
      setSubmitting(false);
    }
  }

  const hora = new Date(reserva.slot_inicio).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const nombreFormat =
    capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';

  return (
    <div className="rec-modal-backdrop" onClick={() => !submitting && onClose()}>
      <div className="rec-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {yaCheckIn ? 'CHECK-IN COMPLETADO' : 'CHECK-IN MANUAL'}
        </p>
        <h3
          style={{
            color: 'var(--ek-ink)',
            fontFamily: 'var(--ek-font-display)',
            fontSize: '1.5rem',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            marginTop: '0.25rem'
          }}
        >
          {nombreFormat}
        </h3>
        <p style={{ color: 'var(--ek-ink-muted)', marginTop: '0.25rem' }}>
          {reserva.recurso?.nombre} · {hora}
        </p>

        {yaCheckIn ? (
          <>
            <p
              style={{
                color: 'var(--ek-success)',
                marginTop: '1rem',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              Ya hizo check-in
              {(() => {
                const m = (reserva as { check_in_method?: string }).check_in_method;
                return m ? ` (${m})` : null;
              })()}
            </p>
            <button onClick={onClose} className="ek-cta ek-cta--full" style={{ marginTop: '1rem' }}>
              Cerrar
            </button>
          </>
        ) : (
          <>
            <label style={{ display: 'block', marginTop: '1.25rem' }}>
              <span className="ek-eyebrow" style={{ color: 'var(--ek-ink-muted)' }}>
                MOTIVO (OPCIONAL)
              </span>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. olvidó su celular"
                className="ek-input"
                style={{ marginTop: '0.5rem' }}
              />
            </label>

            {error && (
              <p style={{ color: 'var(--ek-danger)', marginTop: '1rem', fontSize: '0.875rem' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem' }}>
              <button
                onClick={onClose}
                disabled={submitting}
                className="ek-cta ek-cta--secondary"
                style={{ flex: 1 }}
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                disabled={submitting}
                className="ek-cta"
                style={{ flex: 1 }}
              >
                {submitting ? 'Marcando…' : 'Marcar check-in'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
