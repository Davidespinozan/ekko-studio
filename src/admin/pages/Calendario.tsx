import { useState, useMemo } from 'react';
import { useReservasRango } from '../hooks/useAdminData';
import { useRecursosAdmin } from '../hooks/useAdminData';
import { formatHora } from '@member/logic/reservaLogic';

export default function Calendario() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 7);
    return d;
  }, [weekStart]);

  const { recursos } = useRecursosAdmin();
  const { reservas, isLoading } = useReservasRango(weekStart, weekEnd);

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
    <div className="adm-page">
      <div className="adm-page-header">
        <p className="ek-eyebrow">CALENDARIO</p>
        <h1 className="ek-h2">Reservas de la semana</h1>
      </div>

      <div className="adm-week-nav">
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="adm-link-btn">← Semana anterior</button>
        <span className="adm-week-label">
          {weekStart.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} —
          {' '}
          {addDays(weekStart, 6).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="adm-link-btn">Semana siguiente →</button>
      </div>

      {isLoading ? <p className="adm-body">Cargando…</p> : (
        <div className="adm-cal-grid">
          {days.map((day) => {
            const reservasDelDia = reservas.filter((r) => sameDay(new Date(r.slot_inicio), day));
            return (
              <div key={day.toISOString()} className="adm-cal-day">
                <div className="adm-cal-day-header">
                  <p className="adm-cal-day-name">{day.toLocaleDateString('es-MX', { weekday: 'short' })}</p>
                  <p className="adm-cal-day-num">{day.getDate()}</p>
                </div>
                <div className="adm-cal-events">
                  {reservasDelDia.length === 0 && (
                    <p className="adm-cal-empty">—</p>
                  )}
                  {reservasDelDia.map((r) => (
                    <div key={r.id} className="adm-cal-event" data-status={r.status}>
                      <p className="adm-cal-event-time">{formatHora(new Date(r.slot_inicio))}</p>
                      <p className="adm-cal-event-recurso">{r.recurso?.nombre ?? '—'}</p>
                      <p className="adm-cal-event-usuario">{r.usuario?.nombre ?? r.usuario?.email ?? '—'}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="adm-cal-legend">
        <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-muted)' }}>
          Total recursos: {recursos.length} · Reservas en rango: {reservas.length}
        </p>
      </div>
    </div>
  );
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
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}
