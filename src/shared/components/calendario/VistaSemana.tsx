import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';
import { useReservasRango } from '@shared/hooks/useReservasRango';

/**
 * Vista Semana — grid de 7 columnas. Compartida por admin (Calendario) y
 * recepción (Agenda). Solo apta para ≥768px; en mobile muestra un hint para
 * pasar a una vista compacta (Día en admin, Lista en recepción) vía
 * `vistaCompactaCta`. Read-only: tap en una reserva → `onVerDetalle`.
 */

interface Props {
  refreshTick: number;
  onVerDetalle: (id: string) => void;
  /** CTA del hint mobile: a qué vista compacta saltar (Día/Lista). */
  vistaCompactaCta?: { label: string; onClick: () => void };
}

function formatHora(d: Date): string {
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day; // semana inicia en lunes
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default function VistaSemana({ refreshTick, onVerDetalle, vistaCompactaCta }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    return d;
  }, [weekStart]);

  const { reservas, isLoading, refetch } = useReservasRango(weekStart, weekEnd);

  useEffect(() => {
    if (refreshTick > 0) void refetch();
    // refetch identity changes across renders; lo usamos solo cuando sube tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [weekStart]);

  return (
    <>
      {vistaCompactaCta && (
        <div className="adm-cal-semana-hint">
          <p className="adm-body" style={{ marginBottom: '12px' }}>
            La vista <strong>Semana</strong> funciona mejor en pantallas grandes.
          </p>
          <button
            type="button"
            onClick={vistaCompactaCta.onClick}
            className="ek-cta"
            style={{ minHeight: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
          >
            {vistaCompactaCta.label}
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="adm-cal-semana-desktop">
        <div className="adm-week-nav">
          <button
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            className="adm-link-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Semana anterior
          </button>
          <span className="adm-week-label">
            {weekStart.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} —{' '}
            {addDays(weekStart, 6).toLocaleDateString('es-MX', {
              day: 'numeric',
              month: 'short',
              year: 'numeric'
            })}
          </span>
          <button
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            className="adm-link-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            Semana siguiente
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>

        {isLoading ? (
          <Spinner label="Cargando…" />
        ) : (
          <div className="adm-cal-grid">
            {days.map((day) => {
              const reservasDelDia = reservas.filter((r) => sameDay(new Date(r.slot_inicio), day));
              return (
                <div key={day.toISOString()} className="adm-cal-day">
                  <div className="adm-cal-day-header">
                    <p className="adm-cal-day-name">
                      {day.toLocaleDateString('es-MX', { weekday: 'short' })}
                    </p>
                    <p className="adm-cal-day-num">{day.getDate()}</p>
                  </div>
                  <div className="adm-cal-events">
                    {reservasDelDia.length === 0 && <p className="adm-cal-empty">—</p>}
                    {reservasDelDia.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => onVerDetalle(r.id)}
                        className="adm-cal-event"
                        data-status={r.status}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          font: 'inherit',
                          color: 'inherit',
                          padding: 0
                        }}
                      >
                        <p className="adm-cal-event-time">{formatHora(new Date(r.slot_inicio))}</p>
                        <p className="adm-cal-event-recurso">{r.recurso?.nombre ?? '—'}</p>
                        <p className="adm-cal-event-usuario">
                          {r.usuario?.nombre ?? r.usuario?.email ?? '—'}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="adm-cal-legend">
          <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-muted)' }}>
            Reservas en rango: {reservas.length}
          </p>
        </div>
      </div>
    </>
  );
}
