import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarOff } from 'lucide-react';
import { useReservasRango } from '../../hooks/useAdminData';
import { formatHora } from '@member/logic/reservaLogic';
import { EmptyState } from '@shared/components/EmptyState';
import { hoyISOEnZona, sumarDiasISO, rangoDiaEnZona, formatFechaEnZona, instanteDeFechaHoraEnZona } from '@shared/lib/timezone';

interface Props {
  refreshTick: number;
  onVerDetalle: (id: string) => void;
}

/**
 * Vista Día del calendario admin — mobile-first (Sprint MA1).
 *
 * 1 columna, reservas del día ordenadas por hora, scroll vertical natural.
 * Reemplaza al grid de 7 columnas (inutilizable a 375px) como default en
 * viewports <768px. Cada card es tap target full-width ≥64px.
 */
export default function VistaDia({ refreshTick, onVerDetalle }: Props) {
  // Día del ESTUDIO ('YYYY-MM-DD' en America/Mazatlan), no del navegador.
  const [fecha, setFecha] = useState<string>(() => hoyISOEnZona());

  const rango = useMemo(() => rangoDiaEnZona(fecha), [fecha]);
  const { reservas, isLoading, refetch } = useReservasRango(rango.inicio, rango.fin);

  useEffect(() => {
    if (refreshTick > 0) void refetch();
    // refetch cambia de identidad cada render; solo lo disparamos por tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // El hook ya ordena por slot_inicio asc.
  return (
    <div className="adm-dia">
      <div className="adm-dia-nav">
        <button
          type="button"
          onClick={() => setFecha((f) => sumarDiasISO(f, -1))}
          className="adm-dia-nav-btn"
          aria-label="Día anterior"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className="adm-dia-nav-label">
          <span>{formatFechaLarga(fecha)}</span>
          {esHoy(fecha) && <span className="adm-dia-badge-hoy">Hoy</span>}
        </div>
        <button
          type="button"
          onClick={() => setFecha((f) => sumarDiasISO(f, 1))}
          className="adm-dia-nav-btn"
          aria-label="Día siguiente"
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="ek-skeleton"
              style={{ height: '76px', borderRadius: 'var(--ek-r-sm)' }}
            />
          ))}
        </div>
      ) : reservas.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title="No hay reservas para este día."
          tone="neutral"
        />
      ) : (
        <div className="adm-dia-reservas">
          {reservas.map((r) => {
            const status = statusInfo(r.status);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => onVerDetalle(r.id)}
                className="adm-dia-reserva-card"
                data-status={r.status}
              >
                <span className="adm-dia-reserva-hora">
                  {formatHora(new Date(r.slot_inicio))}
                </span>
                <span className="adm-dia-reserva-info">
                  <span className="adm-dia-reserva-estudio">
                    {r.recurso?.nombre ?? '—'}
                  </span>
                  <span className="adm-dia-reserva-miembro">
                    {r.usuario?.nombre ?? r.usuario?.email ?? '—'}
                  </span>
                </span>
                <span
                  className="adm-dia-reserva-status"
                  style={{ color: status.color }}
                >
                  {status.label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <p className="adm-cal-legend" style={{ marginTop: '12px' }}>
        {reservas.length} {reservas.length === 1 ? 'reserva' : 'reservas'} este día
      </p>
    </div>
  );
}

// ============================================================================
// Helpers de fecha (locales — VistaDia es autosuficiente)
// ============================================================================

function esHoy(fechaISO: string): boolean {
  return fechaISO === hoyISOEnZona();
}

function formatFechaLarga(fechaISO: string): string {
  const s = formatFechaEnZona(instanteDeFechaHoraEnZona(fechaISO, '12:00'), {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusInfo(status: string): { label: string; color: string } {
  switch (status) {
    case 'completada':
      return { label: 'Completada', color: 'var(--ek-success)' };
    case 'cancelada':
    case 'cancelada_admin':
      return { label: 'Cancelada', color: 'var(--ek-danger)' };
    case 'no_show':
      return { label: 'No-show', color: 'var(--ek-ink-faint)' };
    default:
      return { label: 'Confirmada', color: 'var(--ek-mustard)' };
  }
}
