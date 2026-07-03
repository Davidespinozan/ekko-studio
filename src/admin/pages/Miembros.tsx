import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, ArrowRight } from 'lucide-react';
import { useMiembros } from '../hooks/useAdminData';
import { NuevaPersonaModal } from '../components/NuevaPersonaModal';
import { Spinner } from '@shared/components/Spinner';
import { EmptyState } from '@shared/components/EmptyState';

export default function Miembros() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [showNuevo, setShowNuevo] = useState(false);
  // Fijamos rol='miembro' para excluir staff (admins, recepcionistas).
  // El equipo se gestiona desde /admin/equipo (Sprint Equipo).
  const { miembros, isLoading, refetch } = useMiembros({ search, status, rol: 'miembro' });

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: '12px'
        }}
      >
        <div>
          <p className="ek-eyebrow ek-eyebrow--mustard">MIEMBROS</p>
          <h1 className="ek-h2">Tus clientes en EKKO</h1>
          {!isLoading && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '4px' }}>
              {miembros.length}{' '}
              {miembros.length === 1 ? 'cliente' : 'clientes'}
            </p>
          )}
        </div>
        <button onClick={() => setShowNuevo(true)} className="ek-cta">
          + Nuevo miembro
        </button>
      </div>

      <div className="adm-filters">
        <input
          type="text"
          placeholder="Buscar por nombre o email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '280px' }}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '180px' }}
        >
          <option value="">Todos los status</option>
          <option value="activo">Activo</option>
          <option value="pendiente_onboarding">Pendiente onboarding</option>
          <option value="pendiente_pago">Pendiente pago</option>
          <option value="suspendido">Suspendido</option>
          <option value="cancelado">Cancelado</option>
        </select>
      </div>

      {isLoading ? (
        <Spinner label="Cargando…" />
      ) : miembros.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Sin resultados."
          hint="No hay miembros que coincidan con tu búsqueda."
          tone="neutral"
        />
      ) : (
        <>
        {/* Móvil: tarjetas apiladas (la tabla no entra en pantallas chicas). */}
        <div className="adm-cards-mobile">
          {miembros.map((m) => (
            <Link
              key={m.id}
              to={`/admin/miembros/${m.id}`}
              className="adm-card adm-card--interactive"
              style={{
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                textDecoration: 'none',
                color: 'inherit'
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>{m.nombre ?? '—'}</p>
                <p
                  style={{
                    margin: '2px 0 0',
                    fontSize: '12px',
                    color: 'var(--ek-ink-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {m.email}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      color: 'var(--ek-ink-muted)'
                    }}
                  >
                    {m.membresia_tier ?? 'sin plan'}
                  </span>
                  <StatusBadge status={m.status} />
                </div>
              </div>
              <ArrowRight size={16} aria-hidden="true" style={{ color: 'var(--ek-mustard)', flexShrink: 0 }} />
            </Link>
          ))}
        </div>

        {/* Desktop: tabla */}
        <div className="adm-table-wrapper adm-table-desktop">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Alta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {miembros.map((m) => (
                <tr key={m.id}>
                  <td>{m.nombre ?? '—'}</td>
                  <td style={{ color: 'var(--ek-ink-muted)' }}>{m.email}</td>
                  <td>{m.membresia_tier ?? '—'}</td>
                  <td>
                    <StatusBadge status={m.status} />
                  </td>
                  <td style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)' }}>
                    {new Date(m.created_at).toLocaleDateString('es-MX')}
                  </td>
                  <td>
                    <Link
                      to={`/admin/miembros/${m.id}`}
                      className="adm-link"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      Ver
                      <ArrowRight size={13} aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {showNuevo && (
        <NuevaPersonaModal
          onClose={() => setShowNuevo(false)}
          onCreated={async () => {
            await refetch();
            setShowNuevo(false);
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    activo: 'var(--ek-success)',
    pendiente_onboarding: 'var(--ek-warning)',
    pendiente_pago: 'var(--ek-warning)',
    suspendido: 'var(--ek-danger)',
    cancelado: 'var(--ek-ink-muted)'
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem' }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: colorMap[status] ?? 'var(--ek-ink-muted)'
        }}
      />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
