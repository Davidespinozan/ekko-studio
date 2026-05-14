import { useAdminMetrics } from '../hooks/useAdminData';
import { StatCard } from '../components/StatCard';
import { formatHora } from '@member/logic/reservaLogic';

export default function AdminDashboard() {
  const { metrics, isLoading } = useAdminMetrics();

  if (isLoading || !metrics) {
    return <p className="adm-body">Cargando métricas…</p>;
  }

  return (
    <div className="adm-page">
      <div className="adm-page-header">
        <p className="ek-eyebrow">DASHBOARD</p>
        <h1 className="ek-h2">Hoy en EKKO</h1>
      </div>

      <div className="adm-stat-grid">
        <StatCard label="Miembros activos" value={metrics.miembrosActivos} hint={`de ${metrics.miembrosTotal} totales`} />
        <StatCard label="Reservas hoy" value={metrics.reservasHoy} />
        <StatCard label="Reservas este mes" value={metrics.reservasEsteMes} />
        <StatCard label="Ocupación" value="—" hint="por implementar" />
      </div>

      <section className="adm-section">
        <h2 className="ek-h3">Próximas reservas</h2>
        {metrics.proximasReservas.length === 0 ? (
          <p className="adm-body">No hay reservas próximas.</p>
        ) : (
          <div className="adm-table-wrapper">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Cuándo</th>
                  <th>Estudio</th>
                  <th>Miembro</th>
                </tr>
              </thead>
              <tbody>
                {metrics.proximasReservas.map((r) => (
                  <tr key={r.id}>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.folio}</code></td>
                    <td>
                      {new Date(r.slot_inicio).toLocaleDateString('es-MX', {
                        weekday: 'short', day: 'numeric', month: 'short'
                      })}{' '}
                      · {formatHora(new Date(r.slot_inicio))}
                    </td>
                    <td>{r.recurso?.nombre ?? '—'}</td>
                    <td>{r.usuario?.nombre ?? r.usuario?.email ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
