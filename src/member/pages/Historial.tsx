import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useReservasDelUsuario, cancelarReserva } from '../hooks/useReservas';
import { formatHora } from '../logic/reservaLogic';

export default function Historial() {
  const { reservas, isLoading, refetch } = useReservasDelUsuario();
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return <div className="ek-container"><p className="ek-body">Cargando…</p></div>;
  }

  const ahora = new Date();
  const proximas = reservas.filter(
    (r) => r.status === 'confirmada' && new Date(r.slot_inicio) >= ahora
  );
  const pasadas = reservas.filter(
    (r) => r.status !== 'confirmada' || new Date(r.slot_inicio) < ahora
  );

  async function handleCancelar(reserva_id: string) {
    if (!confirm('¿Cancelar esta reserva?')) return;
    setCancelando(reserva_id);
    setError(null);
    const { error: rpcError } = await cancelarReserva({ reserva_id });
    if (rpcError) {
      setError(rpcError);
    } else {
      await refetch();
    }
    setCancelando(null);
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">HISTORIAL</p>
          <h1 className="ek-h2">Tus reservas</h1>
        </div>

        {error && <p className="ek-error-text">{error}</p>}

        {proximas.length === 0 && pasadas.length === 0 ? (
          <p className="ek-body">Aún no tienes reservas.</p>
        ) : (
          <>
            {proximas.length > 0 && (
              <div className="ek-stack-md">
                <p className="ek-eyebrow">PRÓXIMAS</p>
                {proximas.map((r) => (
                  <div key={r.id} className="ek-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                      <div>
                        <h3 className="ek-h3" style={{ marginBottom: '0.25rem' }}>
                          {r.recurso?.nombre ?? 'Estudio'}
                        </h3>
                        <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                          {new Date(r.slot_inicio).toLocaleDateString('es-MX', {
                            weekday: 'long', day: 'numeric', month: 'long'
                          })}
                        </p>
                        <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                          {formatHora(new Date(r.slot_inicio))} – {formatHora(new Date(r.slot_fin))}
                        </p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-muted)', marginTop: '0.5rem', fontFamily: 'var(--ek-font-mono)' }}>
                          {r.folio}
                        </p>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end' }}>
                        <Link
                          to={`/app/qr/${r.id}`}
                          className="ek-cta"
                          style={{ padding: '0.5rem 1rem', minHeight: '36px', fontSize: '0.8125rem' }}
                        >
                          Ver QR →
                        </Link>
                        <button
                          onClick={() => handleCancelar(r.id)}
                          disabled={cancelando === r.id}
                          style={{
                            fontSize: '0.8125rem',
                            color: 'var(--ek-danger)',
                            padding: '0.25rem 0.5rem',
                            minHeight: '32px',
                            fontWeight: 500
                          }}
                        >
                          {cancelando === r.id ? '…' : 'Cancelar'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {pasadas.length > 0 && (
              <div className="ek-stack-md">
                <p className="ek-eyebrow">HISTÓRICO</p>
                {pasadas.map((r) => (
                  <div key={r.id} className="ek-card" style={{ opacity: 0.7 }}>
                    <h3 className="ek-h3" style={{ marginBottom: '0.25rem' }}>
                      {r.recurso?.nombre ?? 'Estudio'}
                    </h3>
                    <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                      {new Date(r.slot_inicio).toLocaleDateString('es-MX', {
                        day: 'numeric', month: 'short'
                      })}{' '}
                      · {formatHora(new Date(r.slot_inicio))} · {' '}
                      <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.status}</code>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
