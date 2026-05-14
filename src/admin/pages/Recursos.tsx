import { useState } from 'react';
import { useRecursosAdmin, updateRecurso } from '../hooks/useAdminData';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Recursos() {
  const { recursos, isLoading, refetch } = useRecursosAdmin();
  const [editing, setEditing] = useState<Recurso | null>(null);

  return (
    <div className="adm-page">
      <div className="adm-page-header">
        <p className="ek-eyebrow">ESTUDIOS</p>
        <h1 className="ek-h2">Recursos reservables</h1>
      </div>

      {isLoading ? <p className="adm-body">Cargando…</p> : (
        <div className="adm-stack">
          {recursos.map((r) => (
            <div key={r.id} className="ek-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                  <h3 className="ek-h3">{r.nombre} {!r.activo && <span style={{ color: 'var(--ek-danger)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>(inactivo)</span>}</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                    Slug: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.slug}</code> ·
                    Tipo: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.tipo}</code> ·
                    Cupos: {r.cupos}
                  </p>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)', marginTop: '0.25rem' }}>
                    Tiers permitidos: {r.tiers_permitidos.join(', ')}
                  </p>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)', marginTop: '0.25rem' }}>
                    Horarios: {Array.isArray(r.horarios) ? `${(r.horarios as any[]).length} bloques` : '—'}
                  </p>
                </div>
                <button onClick={() => setEditing(r)} className="adm-link">Editar →</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditarRecursoModal
          recurso={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refetch();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function EditarRecursoModal({ recurso, onClose, onSaved }: {
  recurso: Recurso;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState(recurso.nombre);
  const [descripcion, setDescripcion] = useState(recurso.descripcion ?? '');
  const [activo, setActivo] = useState(recurso.activo);
  const [tiersStr, setTiersStr] = useState(recurso.tiers_permitidos.join(','));
  const [horariosJSON, setHorariosJSON] = useState(JSON.stringify(recurso.horarios, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);

    let horariosParsed: any;
    try {
      horariosParsed = JSON.parse(horariosJSON);
    } catch (e) {
      setError('Horarios JSON inválido');
      setSaving(false);
      return;
    }

    const tiers = tiersStr.split(',').map((s) => s.trim()).filter(Boolean);
    const { error: err } = await updateRecurso(recurso.id, {
      nombre,
      descripcion: descripcion || null,
      activo,
      tiers_permitidos: tiers,
      horarios: horariosParsed
    });
    if (err) {
      setError(err);
      setSaving(false);
      return;
    }
    await onSaved();
  }

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow">EDITAR RECURSO</p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>{recurso.slug}</h3>

        <label className="ek-label">
          Nombre
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Descripción
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Tiers permitidos (separados por coma)
          <input value={tiersStr} onChange={(e) => setTiersStr(e.target.value)} className="ek-input" placeholder="basica,pro" />
        </label>

        <label className="ek-label">
          Activo
          <select value={activo ? '1' : '0'} onChange={(e) => setActivo(e.target.value === '1')} className="ek-input">
            <option value="1">Sí</option>
            <option value="0">No</option>
          </select>
        </label>

        <label className="ek-label">
          Horarios (JSON)
          <textarea
            value={horariosJSON}
            onChange={(e) => setHorariosJSON(e.target.value)}
            className="ek-input"
            rows={10}
            style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '0.8125rem' }}
          />
          <p className="ek-helper-text">
            Array de bloques: [{`{dia, inicio, fin}`}]. Días: lunes, martes…
          </p>
        </label>

        {error && <p className="ek-error-text">{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button onClick={onClose} disabled={saving} className="ek-cta ek-cta--secondary" style={{ flex: 1 }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving} className="ek-cta" style={{ flex: 1 }}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}
