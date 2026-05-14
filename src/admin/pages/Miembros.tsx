import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMiembros } from '../hooks/useAdminData';
import { NuevaPersonaModal } from '../components/NuevaPersonaModal';

export default function Miembros() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [rolFilter, setRolFilter] = useState<string>('');
  const [showNuevo, setShowNuevo] = useState(false);
  const { miembros, isLoading, refetch } = useMiembros({ search, status, rol: rolFilter });

  return (
    <div className="adm-page">
      <div className="adm-page-header" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <p className="ek-eyebrow">MIEMBROS</p>
          <h1 className="ek-h2">Personas en EKKO</h1>
        </div>
        <button onClick={() => setShowNuevo(true)} className="ek-cta">
          + Nueva persona
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
          value={rolFilter}
          onChange={(e) => setRolFilter(e.target.value)}
          className="ek-input"
          style={{ maxWidth: '180px' }}
        >
          <option value="">Todos los roles</option>
          <option value="miembro">Miembros</option>
          <option value="recepcionista">Recepción</option>
          <option value="staff">Staff (todos)</option>
          <option value="admin">Admin</option>
        </select>
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
        <p className="adm-body">Cargando…</p>
      ) : miembros.length === 0 ? (
        <p className="adm-body">Sin resultados.</p>
      ) : (
        <div className="adm-table-wrapper">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Rol</th>
                <th>Tier</th>
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
                  <td><RolBadge rol={m.rol} /></td>
                  <td>{m.membresia_tier ?? '—'}</td>
                  <td><StatusBadge status={m.status} /></td>
                  <td style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)' }}>
                    {new Date(m.created_at).toLocaleDateString('es-MX')}
                  </td>
                  <td>
                    <Link to={`/admin/miembros/${m.id}`} className="adm-link">Ver →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNuevo && (
        <NuevaPersonaModal
          onClose={() => setShowNuevo(false)}
          onCreated={async () => { await refetch(); setShowNuevo(false); }}
        />
      )}
    </div>
  );
}

function RolBadge({ rol }: { rol: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    admin: { bg: 'var(--ek-black)', color: 'var(--ek-mustard)' },
    staff: { bg: 'var(--ek-ink-muted)', color: 'var(--ek-cream)' },
    recepcionista: { bg: 'var(--ek-info)', color: 'var(--ek-cream)' },
    miembro: { bg: 'var(--ek-cream-deep)', color: 'var(--ek-black)' }
  };
  const s = styles[rol] ?? styles.miembro;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '0.75rem',
      fontWeight: 600,
      background: s.bg,
      color: s.color
    }}>
      {rol}
    </span>
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
      <span style={{
        width: '8px', height: '8px', borderRadius: '50%',
        background: colorMap[status] ?? 'var(--ek-ink-muted)'
      }} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}
