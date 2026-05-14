import { useState } from 'react';
import { useTiersAdmin, updateTier } from '../hooks/useAdminData';
import type { Database } from '@shared/types/database';

type Tier = Database['public']['Tables']['tiers']['Row'];

export default function Tiers() {
  const { tiers, isLoading, refetch } = useTiersAdmin();
  const [editing, setEditing] = useState<Tier | null>(null);

  return (
    <div className="adm-page">
      <div className="adm-page-header">
        <p className="ek-eyebrow">PLANES</p>
        <h1 className="ek-h2">Membresías</h1>
      </div>

      {isLoading ? <p className="adm-body">Cargando…</p> : (
        <div className="adm-stack">
          {tiers.map((t) => (
            <div key={t.id} className="ek-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 className="ek-h3">{t.nombre}</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                    ${(t.precio_centavos / 100).toLocaleString('es-MX')} {t.moneda} / {t.periodo}
                  </p>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--ek-ink-muted)', marginTop: '0.5rem' }}>
                    {Array.isArray(t.beneficios) ? `${(t.beneficios as any[]).length} beneficios` : '—'} ·
                    {' '}{t.activo ? 'activo' : 'inactivo'}
                  </p>
                </div>
                <button onClick={() => setEditing(t)} className="adm-link">Editar →</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditarTierModal tier={editing} onClose={() => setEditing(null)} onSaved={async () => { await refetch(); setEditing(null); }} />
      )}
    </div>
  );
}

function EditarTierModal({ tier, onClose, onSaved }: { tier: Tier; onClose: () => void; onSaved: () => Promise<void> }) {
  const [nombre, setNombre] = useState(tier.nombre);
  const [precio, setPrecio] = useState(String(tier.precio_centavos / 100));
  const [descripcion, setDescripcion] = useState(tier.descripcion ?? '');
  const [activo, setActivo] = useState(tier.activo);
  const [beneficiosJSON, setBeneficiosJSON] = useState(JSON.stringify(tier.beneficios, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);

    let beneficiosParsed: any;
    try {
      beneficiosParsed = JSON.parse(beneficiosJSON);
    } catch {
      setError('Beneficios JSON inválido');
      setSaving(false);
      return;
    }

    const precioCentavos = Math.round(parseFloat(precio) * 100);
    if (!Number.isFinite(precioCentavos)) {
      setError('Precio inválido');
      setSaving(false);
      return;
    }

    const { error: err } = await updateTier(tier.id, {
      nombre,
      descripcion: descripcion || null,
      precio_centavos: precioCentavos,
      beneficios: beneficiosParsed,
      activo
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
        <p className="ek-eyebrow">EDITAR PLAN</p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>{tier.slug}</h3>

        <label className="ek-label">
          Nombre
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Descripción
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Precio (MXN)
          <input type="number" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Activo
          <select value={activo ? '1' : '0'} onChange={(e) => setActivo(e.target.value === '1')} className="ek-input">
            <option value="1">Sí</option>
            <option value="0">No</option>
          </select>
        </label>

        <label className="ek-label">
          Beneficios (JSON)
          <textarea
            value={beneficiosJSON}
            onChange={(e) => setBeneficiosJSON(e.target.value)}
            className="ek-input"
            rows={12}
            style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '0.8125rem' }}
          />
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
