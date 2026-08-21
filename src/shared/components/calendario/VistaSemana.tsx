import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react';
import { Spinner } from '@shared/components/Spinner';
import { useReservasRango } from '@shared/hooks/useReservasRango';
import {
  hoyISOEnZona,
  sumarDiasISO,
  diaSemanaDeFechaISO,
  rangoDiaEnZona,
  fechaISOEnZona,
  formatFechaEnZona,
  formatHoraEnZona,
  instanteDeFechaHoraEnZona
} from '@shared/lib/timezone';

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

// Todo en fechas de calendario del ESTUDIO ('YYYY-MM-DD' en America/Mazatlan),
// no en el reloj del navegador: el admin remoto veía la semana corrida.
function lunesDeLaSemana(fechaISO: string): string {
  const dow = diaSemanaDeFechaISO(fechaISO); // 0=dom … 6=sáb
  const diff = dow === 0 ? -6 : 1 - dow; // la semana inicia en lunes
  return sumarDiasISO(fechaISO, diff);
}

function etiquetaFecha(fechaISO: string, opts: Intl.DateTimeFormatOptions): string {
  return formatFechaEnZona(instanteDeFechaHoraEnZona(fechaISO, '12:00'), opts);
}

export default function VistaSemana({ refreshTick, onVerDetalle, vistaCompactaCta }: Props) {
  const [weekStart, setWeekStart] = useState<string>(() => lunesDeLaSemana(hoyISOEnZona()));
  const rango = useMemo(
    () => ({ inicio: rangoDiaEnZona(weekStart).inicio, fin: rangoDiaEnZona(sumarDiasISO(weekStart, 7)).inicio }),
    [weekStart]
  );

  const { reservas, isLoading, refetch } = useReservasRango(rango.inicio, rango.fin);

  useEffect(() => {
    if (refreshTick > 0) void refetch();
    // refetch identity changes across renders; lo usamos solo cuando sube tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => sumarDiasISO(weekStart, i)), [weekStart]);

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
            onClick={() => setWeekStart(sumarDiasISO(weekStart, -7))}
            className="adm-link-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            Semana anterior
          </button>
          <span className="adm-week-label">
            {etiquetaFecha(weekStart, { day: 'numeric', month: 'short' })} —{' '}
            {etiquetaFecha(sumarDiasISO(weekStart, 6), { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
          <button
            onClick={() => setWeekStart(sumarDiasISO(weekStart, 7))}
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
              const reservasDelDia = reservas.filter((r) => fechaISOEnZona(r.slot_inicio) === day);
              return (
                <div key={day} className="adm-cal-day">
                  <div className="adm-cal-day-header">
                    <p className="adm-cal-day-name">
                      {etiquetaFecha(day, { weekday: 'short' })}
                    </p>
                    <p className="adm-cal-day-num">{Number(day.slice(8, 10))}</p>
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
                        <p className="adm-cal-event-time">{formatHoraEnZona(r.slot_inicio)}</p>
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
