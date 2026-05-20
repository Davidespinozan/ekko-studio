import { useEffect, useMemo, useState } from 'react';
import { useReservasRango } from '../../hooks/useAdminData';
import { formatHora } from '@member/logic/reservaLogic';

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
  const [fecha, setFecha] = useState(() => startOfDay(new Date()));

  const finDia = useMemo(() => addDays(fecha, 1), [fecha]);
  const { reservas, isLoading, refetch } = useReservasRango(fecha, finDia);

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
          onClick={() => setFecha((f) => addDays(f, -1))}
          className="adm-dia-nav-btn"
          aria-label="Día anterior"
        >
          ←
        </button>
        <div className="adm-dia-nav-label">
          <span>{formatFechaLarga(fecha)}</span>
          {esHoy(fecha) && <span className="adm-dia-badge-hoy">Hoy</span>}
        </div>
        <button
          type="button"
          onClick={() => setFecha((f) => addDays(f, 1))}
          className="adm-dia-nav-btn"
          aria-label="Día siguiente"
        >
          →
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
        <div className="ek-empty" style={{ padding: '40px 0', textAlign: 'center' }}>
          <p className="adm-body" style={{ color: 'var(--ek-ink-muted)' }}>
            No hay reservas para este día.
          </p>
        </div>
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

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function esHoy(d: Date): boolean {
  const hoy = new Date();
  return (
    d.getFullYear() === hoy.getFullYear() &&
    d.getMonth() === hoy.getMonth() &&
    d.getDate() === hoy.getDate()
  );
}

function formatFechaLarga(d: Date): string {
  const s = d.toLocaleDateString('es-MX', {
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
