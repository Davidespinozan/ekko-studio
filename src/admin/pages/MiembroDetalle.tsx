import { useParams, Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useMiembroDetalle, updateMiembro, adminUpdateRole } from '../hooks/useAdminData';
import { formatHora } from '@member/logic/reservaLogic';

export default function MiembroDetalle() {
  const { id } = useParams<{ id: string }>();
  const { miembro, reservas, isLoading, refetch } = useMiembroDetalle(id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status: string; membresia_tier: string }>({
    status: '',
    membresia_tier: ''
  });

  useEffect(() => {
    if (miembro) {
      setDraft({ status: miembro.status, membresia_tier: miembro.membresia_tier ?? '' });
    }
  }, [miembro]);

  if (isLoading) return <p className="adm-body">Cargando…</p>;
  if (!miembro) return <p className="adm-body">Miembro no encontrado.</p>;

  async function handleSave() {
    setSaving(true);
    setError(null);
    const { error: err } = await updateMiembro(miembro!.id, {
      status: draft.status as any,
      membresia_tier: draft.membresia_tier || null
    });
    if (err) {
      setError(err);
    } else {
      await refetch();
    }
    setSaving(false);
  }

  return (
    <div className="adm-page">
      <Link to="/admin/miembros" className="adm-link">← Volver</Link>

      <div className="adm-page-header" style={{ marginTop: '1rem' }}>
        <p className="ek-eyebrow">MIEMBRO</p>
        <h1 className="ek-h2">{miembro.nombre ?? miembro.email}</h1>
      </div>

      <section className="adm-section">
        <h2 className="ek-h3">Información</h2>
        <div className="adm-info-grid">
          <Info label="Email" value={miembro.email} />
          <Info label="Teléfono" value={miembro.telefono ?? '—'} />
          <Info label="Rol" value={miembro.rol} mono />
          <Info label="Alta" value={new Date(miembro.created_at).toLocaleString('es-MX')} />
          {miembro.commitment_ends_at && (
            <Info label="Commitment hasta" value={new Date(miembro.commitment_ends_at).toLocaleDateString('es-MX')} />
          )}
          {miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta) > new Date() && (
            <Info label="Bloqueado hasta" value={new Date(miembro.bloqueado_hasta).toLocaleString('es-MX')} />
          )}
          <Info label="No-shows" value={miembro.no_shows_count} />
        </div>
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Acciones</h2>
        <div className="adm-form-row">
          <label className="ek-label">
            Status
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
              className="ek-input"
            >
              <option value="pendiente_onboarding">pendiente_onboarding</option>
              <option value="pendiente_pago">pendiente_pago</option>
              <option value="activo">activo</option>
              <option value="suspendido">suspendido</option>
              <option value="cancelado">cancelado</option>
            </select>
          </label>
          <label className="ek-label">
            Tier
            <select
              value={draft.membresia_tier}
              onChange={(e) => setDraft((d) => ({ ...d, membresia_tier: e.target.value }))}
              className="ek-input"
            >
              <option value="">— sin tier —</option>
              <option value="basica">basica</option>
              <option value="pro">pro</option>
            </select>
          </label>
        </div>
        {error && <p className="ek-error-text">{error}</p>}
        <button onClick={handleSave} disabled={saving} className="ek-cta" style={{ marginTop: '1rem', alignSelf: 'flex-start' }}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Rol</h2>
        <p className="adm-body">
          Rol actual: <RolBadge rol={miembro.rol} />
        </p>
        <CambiarRolControl
          usuarioId={miembro.id}
          rolActual={miembro.rol}
          onChanged={refetch}
        />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Reservas ({reservas.length})</h2>
        {reservas.length === 0 ? (
          <p className="adm-body">Sin reservas.</p>
        ) : (
          <div className="adm-table-wrapper">
            <table className="adm-table">
              <thead>
                <tr><th>Folio</th><th>Fecha</th><th>Estudio</th><th>Status</th></tr>
              </thead>
              <tbody>
                {reservas.map((r) => (
                  <tr key={r.id}>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.folio}</code></td>
                    <td>
                      {new Date(r.slot_inicio).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}
                      {' · '}
                      {formatHora(new Date(r.slot_inicio))}
                    </td>
                    <td>{r.recurso?.nombre ?? '—'}</td>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.status}</code></td>
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

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="adm-info-label">{label}</p>
      <p className="adm-info-value" style={mono ? { fontFamily: 'var(--ek-font-mono)' } : undefined}>
        {value}
      </p>
    </div>
  );
}

function RolBadge({ rol }: { rol: string }) {
  return <code style={{ fontFamily: 'var(--ek-font-mono)', background: 'var(--ek-cream-deep)', padding: '2px 8px', borderRadius: '4px' }}>{rol}</code>;
}

function CambiarRolControl({ usuarioId, rolActual, onChanged }: {
  usuarioId: string;
  rolActual: string;
  onChanged: () => Promise<void>;
}) {
  const [nuevoRol, setNuevoRol] = useState<'miembro' | 'recepcionista' | 'staff' | 'admin'>(rolActual as any);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  async function handleSave() {
    if (nuevoRol === rolActual) return;
    if (nuevoRol === 'admin' && !needsConfirm) {
      setNeedsConfirm(true);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await adminUpdateRole({ usuario_id: usuarioId, rol: nuevoRol });
      await onChanged();
      setNeedsConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cambiando rol');
    }
    setSaving(false);
  }

  return (
    <div className="adm-form-row" style={{ marginTop: '0.5rem' }}>
      <label className="ek-label" style={{ flex: 1 }}>
        Nuevo rol
        <select
          value={nuevoRol}
          onChange={(e) => setNuevoRol(e.target.value as any)}
          className="ek-input"
        >
          <option value="miembro">Miembro</option>
          <option value="recepcionista">Recepción</option>
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      <button
        onClick={handleSave}
        disabled={saving || nuevoRol === rolActual}
        className="ek-cta"
        style={{ alignSelf: 'flex-end' }}
      >
        {saving ? '…' : needsConfirm && nuevoRol === 'admin' ? 'Confirmar admin' : 'Cambiar rol'}
      </button>
      {error && <p className="ek-error-text">{error}</p>}
      {needsConfirm && nuevoRol === 'admin' && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--ek-danger)', flexBasis: '100%', marginTop: '0.5rem' }}>
          ⚠️ Promover a admin da acceso TOTAL al negocio. Click "Confirmar admin" para proceder.
        </p>
      )}
    </div>
  );
}
