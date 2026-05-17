import { useState } from 'react';
import { useTiersAdmin, updateTier } from '../hooks/useAdminData';
import Toggle from '../components/Toggle';
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

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <div className="adm-stack">
          {tiers.map((t) => (
            <div key={t.id} className="ek-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start'
                }}
              >
                <div>
                  <h3 className="ek-h3">{t.nombre}</h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                    ${(t.precio_centavos / 100).toLocaleString('es-MX')} {t.moneda} /{' '}
                    {t.periodo}
                  </p>
                  <p
                    style={{
                      fontSize: '0.8125rem',
                      color: 'var(--ek-ink-muted)',
                      marginTop: '0.5rem'
                    }}
                  >
                    {Array.isArray(t.beneficios)
                      ? `${(t.beneficios as unknown[]).length} beneficios`
                      : '—'}{' '}
                    · {t.activo ? 'activo' : 'inactivo'}
                  </p>
                </div>
                <button onClick={() => setEditing(t)} className="adm-link">
                  Editar →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EditarTierModal
          tier={editing}
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

function parseBeneficios(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.filter((b): b is string => typeof b === 'string');
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((b): b is string => typeof b === 'string')
        : [];
    }
    return [];
  } catch {
    return [];
  }
}

function EditarTierModal({
  tier,
  onClose,
  onSaved
}: {
  tier: Tier;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState(tier.nombre);
  const [precio, setPrecio] = useState(String(tier.precio_centavos / 100));
  const [descripcion, setDescripcion] = useState(tier.descripcion ?? '');
  const [activo, setActivo] = useState(tier.activo);
  const [beneficios, setBeneficios] = useState<string[]>(() => parseBeneficios(tier.beneficios));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);

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
      beneficios,
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
        <p className="ek-eyebrow ek-eyebrow--mustard">EDITAR PLAN</p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>{tier.nombre}</h3>

        <label className="ek-label">
          Nombre
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} className="ek-input" />
        </label>

        <label className="ek-label">
          Descripción
          <input
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            className="ek-input"
          />
        </label>

        <label className="ek-label">
          Precio (MXN)
          <input
            type="number"
            step="0.01"
            value={precio}
            onChange={(e) => setPrecio(e.target.value)}
            className="ek-input"
          />
        </label>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Plan activo"
            description="Si está inactivo, no se puede asignar a nuevos miembros."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Beneficios del plan</label>
          <BeneficiosEditor value={beneficios} onChange={setBeneficios} />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Lista de beneficios que se muestran al miembro en la landing y signup.
          </p>
        </div>

        {error && <p className="ek-error-text">{error}</p>}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button
            onClick={onClose}
            disabled={saving}
            className="ek-cta ek-cta--secondary"
            style={{ flex: 1 }}
          >
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

function BeneficiosEditor({
  value,
  onChange
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [nuevo, setNuevo] = useState('');

  const agregar = () => {
    const trim = nuevo.trim();
    if (!trim) return;
    onChange([...value, trim]);
    setNuevo('');
  };

  const eliminar = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const editar = (idx: number, nuevoTexto: string) => {
    onChange(value.map((b, i) => (i === idx ? nuevoTexto : b)));
  };

  const mover = (idx: number, dir: 'up' | 'down') => {
    const newIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= value.length) return;
    const newArr = [...value];
    [newArr[idx], newArr[newIdx]] = [newArr[newIdx], newArr[idx]];
    onChange(newArr);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {value.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', fontStyle: 'italic' }}>
          Sin beneficios. Agrega el primero abajo.
        </p>
      )}

      {value.map((beneficio, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid',
            gridTemplateColumns: '24px 1fr auto auto auto',
            gap: '8px',
            alignItems: 'center',
            padding: '8px',
            background: 'var(--ek-bg-elevated)',
            borderRadius: 'var(--ek-r-sm)'
          }}
        >
          <span style={{ color: 'var(--ek-mustard)', textAlign: 'center', fontSize: '14px' }}>
            ✓
          </span>

          <input
            type="text"
            value={beneficio}
            onChange={(e) => editar(idx, e.target.value)}
            className="ek-input"
            style={{ fontSize: '13px', padding: '6px 10px' }}
          />

          <button
            type="button"
            onClick={() => mover(idx, 'up')}
            disabled={idx === 0}
            className="ek-icon-btn"
            style={{ padding: '4px 8px', fontSize: '12px', opacity: idx === 0 ? 0.3 : 1 }}
            aria-label="Subir"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => mover(idx, 'down')}
            disabled={idx === value.length - 1}
            className="ek-icon-btn"
            style={{
              padding: '4px 8px',
              fontSize: '12px',
              opacity: idx === value.length - 1 ? 0.3 : 1
            }}
            aria-label="Bajar"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => eliminar(idx)}
            className="ek-icon-btn"
            style={{ padding: '4px 8px', fontSize: '12px', color: 'var(--ek-danger)' }}
            aria-label="Eliminar"
          >
            ✕
          </button>
        </div>
      ))}

      <div
        style={{
          display: 'flex',
          gap: '8px',
          paddingTop: '8px',
          borderTop: '0.5px dashed var(--ek-line)'
        }}
      >
        <input
          type="text"
          placeholder="Ej: Acceso a TODOS los estudios"
          value={nuevo}
          onChange={(e) => setNuevo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              agregar();
            }
          }}
          className="ek-input"
          style={{ flex: 1, fontSize: '13px' }}
        />
        <button
          type="button"
          onClick={agregar}
          className="ek-cta"
          style={{ padding: '8px 16px', fontSize: '12px', whiteSpace: 'nowrap' }}
        >
          + Agregar
        </button>
      </div>
    </div>
  );
}
