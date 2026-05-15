import { useAdminMetrics, type ReservaConJoin } from '../hooks/useAdminData';

function capitalizarNombre(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export default function AdminDashboard() {
  const { metrics, isLoading } = useAdminMetrics();

  if (isLoading || !metrics) {
    return (
      <div>
        <div className="ek-skeleton" style={{ height: '40px', width: '200px', marginBottom: '8px' }} />
        <div className="ek-skeleton" style={{ height: '56px', width: '280px', marginBottom: '32px' }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="ek-skeleton" style={{ height: '140px' }} />
          ))}
        </div>
      </div>
    );
  }

  const porcentajeNoShows =
    metrics.reservasEsteMes > 0
      ? Math.round((metrics.noShowsMes / metrics.reservasEsteMes) * 100)
      : 0;

  return (
    <div>
      <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>DASHBOARD</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          margin: 0,
          marginBottom: '40px'
        }}
      >
        Hoy en EKKO
      </h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '16px',
          marginBottom: '40px'
        }}
      >
        <StatCard
          eyebrow="MIEMBROS ACTIVOS"
          valor={metrics.miembrosActivos}
          sublabel={`de ${metrics.miembrosTotal} ${metrics.miembrosTotal === 1 ? 'total' : 'totales'}`}
        />
        <StatCard
          eyebrow="RESERVAS HOY"
          valor={metrics.reservasHoy}
          sublabel={metrics.reservasHoy === 1 ? 'sesión' : 'sesiones'}
        />
        <StatCard
          eyebrow="NO-SHOWS MES"
          valor={`${porcentajeNoShows}%`}
          sublabel={`${metrics.noShowsMes} de ${metrics.reservasEsteMes}`}
          highlight={porcentajeNoShows > 15 ? 'danger' : undefined}
        />
        <StatCard
          eyebrow="OCUPACIÓN 7D"
          valor={`${metrics.ocupacion7d}%`}
          sublabel="de slots disponibles"
          highlight="mustard"
        />
      </div>

      <section>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>AGENDA</p>
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(24px, 3.5vw, 32px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: 0,
            marginBottom: '20px'
          }}
        >
          Próximas reservas
        </h2>

        {metrics.proximasReservas.length === 0 ? (
          <p className="ek-body-faint" style={{ padding: '20px 0' }}>
            No hay reservas próximas.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {metrics.proximasReservas.map((r) => (
              <ProximaReservaRow key={r.id} reserva={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  eyebrow,
  valor,
  sublabel,
  highlight
}: {
  eyebrow: string;
  valor: number | string;
  sublabel?: string;
  highlight?: 'mustard' | 'danger';
}) {
  const colorValor =
    highlight === 'danger'
      ? 'var(--ek-danger)'
      : highlight === 'mustard'
      ? 'var(--ek-mustard)'
      : 'var(--ek-ink)';

  return (
    <div className="ek-card" style={{ padding: '24px', position: 'relative', overflow: 'hidden' }}>
      {highlight === 'mustard' && (
        <div
          style={{
            position: 'absolute',
            top: '-40px',
            right: '-40px',
            width: '120px',
            height: '120px',
            background: 'radial-gradient(circle, rgba(229, 184, 41, 0.1), transparent 70%)',
            borderRadius: '50%',
            pointerEvents: 'none'
          }}
        />
      )}
      <p className="ek-eyebrow" style={{ marginBottom: '12px', fontSize: '10px' }}>
        {eyebrow}
      </p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '40px',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          margin: 0,
          marginBottom: '8px',
          color: colorValor
        }}
      >
        {valor}
      </p>
      {sublabel && (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>{sublabel}</p>
      )}
    </div>
  );
}

function ProximaReservaRow({ reserva }: { reserva: ReservaConJoin }) {
  const nombreFormat = capitalizarNombre(reserva.usuario?.nombre) || reserva.usuario?.email || '—';
  const tier = reserva.usuario?.membresia_tier;

  const fecha = new Date(reserva.slot_inicio);
  const hora = fecha.toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const dia = fecha.toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });

  return (
    <div
      className="ek-card"
      style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '16px 20px' }}
    >
      <div style={{ minWidth: '90px' }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '20px',
            fontWeight: 700,
            letterSpacing: '-0.02em',
            margin: 0,
            color: 'var(--ek-ink)'
          }}
        >
          {hora}
        </p>
        <p
          style={{
            fontSize: '11px',
            color: 'var(--ek-ink-faint)',
            margin: 0,
            textTransform: 'uppercase',
            letterSpacing: '0.08em'
          }}
        >
          {dia}
        </p>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '15px',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: 0,
            marginBottom: '4px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {nombreFormat}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
          {reserva.recurso?.nombre ?? '—'} · {tier ?? 'sin plan'}
        </p>
      </div>

      <span className="ek-badge ek-badge--neutral" style={{ fontSize: '10px', flexShrink: 0 }}>
        {reserva.folio}
      </span>
    </div>
  );
}
