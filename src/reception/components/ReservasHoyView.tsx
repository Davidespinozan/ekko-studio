import { useState, useMemo } from 'react';
import { useReservasHoy, checkInManual, type ReservaConJoin } from '../hooks/useReservasHoy';

interface Props {
  onManualCheckInSuccess?: (data: any) => void;
}

export function ReservasHoyView({ onManualCheckInSuccess }: Props = {}) {
  const [fechaSeleccionada, setFechaSeleccionada] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const { reservas, isLoading, refetch } = useReservasHoy(fechaSeleccionada);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReservaConJoin | null>(null);

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const esHoy = fechaSeleccionada.getTime() === hoy.getTime();

  const formatFecha = (d: Date) => {
    if (d.getTime() === hoy.getTime()) return 'Hoy';
    return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  };

  const cambiarDia = (delta: number) => {
    const nueva = new Date(fechaSeleccionada);
    nueva.setDate(nueva.getDate() + delta);
    setFechaSeleccionada(nueva);
  };

  const irAHoy = () => setFechaSeleccionada(new Date(hoy));

  const handleDateInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) return;
    const [y, m, d] = e.target.value.split('-').map(Number);
    const nueva = new Date(y, m - 1, d);
    nueva.setHours(0, 0, 0, 0);
    setFechaSeleccionada(nueva);
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return reservas;
    const term = search.toLowerCase();
    return reservas.filter((r) => {
      const nombre = r.usuario?.nombre?.toLowerCase() ?? '';
      const email = r.usuario?.email?.toLowerCase() ?? '';
      return nombre.includes(term) || email.includes(term);
    });
  }, [reservas, search]);

  const { llegando, resto } = useMemo(() => {
    const now = Date.now();
    const llegando: ReservaConJoin[] = [];
    const resto: ReservaConJoin[] = [];
    filtered.forEach((r) => {
      const inicio = new Date(r.slot_inicio).getTime();
      const fin = new Date(r.slot_fin).getTime();
      // "Llegando ahora" solo aplica si la fecha vista es hoy
      if (esHoy && ((now >= inicio - 15 * 60_000 && now <= fin) || (now >= inicio - 15 * 60_000 && now <= inicio + 15 * 60_000))) {
        llegando.push(r);
      } else {
        resto.push(r);
      }
    });
    return { llegando, resto };
  }, [filtered, esHoy]);

  if (isLoading) {
    return <p style={{ color: 'var(--ek-cream)', textAlign: 'center', marginTop: '2rem' }}>Cargando agenda…</p>;
  }

  return (
    <div className="rec-hoy">
      <div className="rec-day-selector">
        <button onClick={() => cambiarDia(-1)} className="rec-day-arrow" aria-label="Día anterior">
          ←
        </button>
        <div className="rec-day-center">
          <label className="rec-day-label">
            <span className="rec-day-text">{formatFecha(fechaSeleccionada)}</span>
            <input
              type="date"
              value={fechaSeleccionada.toISOString().slice(0, 10)}
              onChange={handleDateInput}
              className="rec-day-input"
            />
          </label>
          {!esHoy && (
            <button onClick={irAHoy} className="rec-day-today-btn">
              Ir a hoy
            </button>
          )}
        </div>
        <button onClick={() => cambiarDia(1)} className="rec-day-arrow" aria-label="Día siguiente">
          →
        </button>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por nombre o email…"
        className="rec-search"
      />

      {llegando.length > 0 && (
        <section>
          <h2 className="rec-section-title">Llegando ahora</h2>
          <div className="rec-list">
            {llegando.map((r) => (
              <ReservaCard key={r.id} reserva={r} onSelect={setSelected} highlight />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="rec-section-title">
          {esHoy ? 'Resto del día' : 'Reservas del día'}
        </h2>
        {resto.length === 0 ? (
          <p style={{ color: 'rgba(245,241,232,0.5)', fontSize: '0.875rem', padding: '1rem' }}>
            Sin más reservas hoy.
          </p>
        ) : (
          <div className="rec-list">
            {resto.map((r) => (
              <ReservaCard key={r.id} reserva={r} onSelect={setSelected} />
            ))}
          </div>
        )}
      </section>

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

function ReservaCard({ reserva, onSelect, highlight }: {
  reserva: ReservaConJoin;
  onSelect: (r: ReservaConJoin) => void;
  highlight?: boolean;
}) {
  const hora = new Date(reserva.slot_inicio).toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  const statusColor: Record<string, string> = {
    confirmada: 'var(--ek-warning)',
    completada: 'var(--ek-success)',
    cancelada: 'var(--ek-danger)',
    no_show: 'rgba(245,241,232,0.4)'
  };

  return (
    <button
      onClick={() => onSelect(reserva)}
      disabled={reserva.status === 'cancelada' || reserva.status === 'no_show'}
      className={`rec-card ${highlight ? 'rec-card--highlight' : ''}`}
    >
      <div className="rec-card-hora">{hora}</div>
      <div className="rec-card-info">
        <p className="rec-card-nombre">
          {reserva.usuario?.nombre ?? reserva.usuario?.email ?? '—'}
        </p>
        <p className="rec-card-meta">
          {reserva.recurso?.nombre ?? '—'}
          {reserva.usuario?.membresia_tier && ` · ${reserva.usuario.membresia_tier}`}
        </p>
      </div>
      <span
        className="rec-card-status"
        style={{ background: statusColor[reserva.status] ?? 'rgba(245,241,232,0.2)' }}
      >
        {reserva.status === 'completada' ? '✓' : reserva.status === 'confirmada' ? 'Pendiente' : reserva.status}
      </span>
    </button>
  );
}

function ManualCheckInModal({ reserva, onClose, onDone }: {
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
      await onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en check-in');
      setSubmitting(false);
    }
  }

  const hora = new Date(reserva.slot_inicio).toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  return (
    <div className="rec-modal-backdrop" onClick={() => !submitting && onClose()}>
      <div className="rec-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow" style={{ color: 'var(--ek-cream)' }}>
          {yaCheckIn ? 'CHECK-IN COMPLETADO' : 'CHECK-IN MANUAL'}
        </p>
        <h3 style={{ color: 'var(--ek-cream)', fontSize: '1.5rem', fontWeight: 700, marginTop: '0.25rem' }}>
          {reserva.usuario?.nombre ?? reserva.usuario?.email ?? '—'}
        </h3>
        <p style={{ color: 'rgba(245,241,232,0.7)', marginTop: '0.25rem' }}>
          {reserva.recurso?.nombre} · {hora}
        </p>

        {yaCheckIn ? (
          <>
            <p style={{ color: 'var(--ek-success)', marginTop: '1rem', fontWeight: 600 }}>
              ✓ Ya hizo check-in
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
              <span className="ek-eyebrow" style={{ color: 'rgba(245,241,232,0.7)' }}>
                MOTIVO (OPCIONAL)
              </span>
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Ej. olvidó su celular"
                className="rec-input"
                style={{ marginTop: '0.5rem' }}
              />
            </label>

            {error && (
              <p style={{ color: 'var(--ek-danger)', marginTop: '1rem', fontSize: '0.875rem' }}>{error}</p>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
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
                style={{ flex: 1, background: 'var(--ek-success)', color: 'var(--ek-cream)' }}
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
