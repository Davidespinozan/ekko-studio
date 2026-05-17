import { useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useRecursosAdmin, updateRecurso } from '../hooks/useAdminData';
import Toggle from '../components/Toggle';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

interface BloqueHorario {
  dia: string;
  inicio: string;
  fin: string;
}

interface TierOption {
  slug: string;
  nombre: string;
}

const DIAS = [
  { key: 'lunes', label: 'Lunes' },
  { key: 'martes', label: 'Martes' },
  { key: 'miercoles', label: 'Miércoles' },
  { key: 'jueves', label: 'Jueves' },
  { key: 'viernes', label: 'Viernes' },
  { key: 'sabado', label: 'Sábado' },
  { key: 'domingo', label: 'Domingo' }
] as const;

function useTiersDelTenant(): TierOption[] {
  const tenant = useTenant();
  const [tiers, setTiers] = useState<TierOption[]>([]);

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('tiers')
        .select('slug, nombre')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (error) {
        console.error('[useTiersDelTenant]', error);
        setTiers([
          { slug: 'basica', nombre: 'Básica' },
          { slug: 'pro', nombre: 'Pro' }
        ]);
      } else {
        setTiers(data ?? []);
      }
    }
    load();
  }, [tenant.id]);

  return tiers;
}

export default function Recursos() {
  const { recursos, isLoading, refetch } = useRecursosAdmin();
  const [editing, setEditing] = useState<Recurso | null>(null);

  return (
    <div className="adm-page">
      <div className="adm-page-header">
        <p className="ek-eyebrow">ESTUDIOS</p>
        <h1 className="ek-h2">Recursos reservables</h1>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <div className="adm-stack">
          {recursos.map((r) => (
            <div key={r.id} className="ek-card">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '1rem'
                }}
              >
                <div>
                  <h3 className="ek-h3">
                    {r.nombre}{' '}
                    {!r.activo && (
                      <span
                        style={{
                          color: 'var(--ek-danger)',
                          fontSize: '0.75rem',
                          marginLeft: '0.5rem'
                        }}
                      >
                        (inactivo)
                      </span>
                    )}
                  </h3>
                  <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
                    Cupos: {r.cupos}
                  </p>
                  <p
                    style={{
                      fontSize: '0.8125rem',
                      color: 'var(--ek-ink-muted)',
                      marginTop: '0.25rem'
                    }}
                  >
                    Planes con acceso: {r.tiers_permitidos.join(', ') || '—'}
                  </p>
                  <p
                    style={{
                      fontSize: '0.8125rem',
                      color: 'var(--ek-ink-muted)',
                      marginTop: '0.25rem'
                    }}
                  >
                    Horarios:{' '}
                    {Array.isArray(r.horarios)
                      ? `${(r.horarios as unknown[]).length} bloques`
                      : '—'}
                  </p>
                </div>
                <button onClick={() => setEditing(r)} className="adm-link">
                  Editar →
                </button>
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

function parseHorarios(raw: unknown): BloqueHorario[] {
  try {
    if (Array.isArray(raw)) return raw as BloqueHorario[];
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  } catch {
    return [];
  }
}

function EditarRecursoModal({
  recurso,
  onClose,
  onSaved
}: {
  recurso: Recurso;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tiersDisponibles = useTiersDelTenant();

  const [nombre, setNombre] = useState(recurso.nombre);
  const [descripcion, setDescripcion] = useState(recurso.descripcion ?? '');
  const [activo, setActivo] = useState(recurso.activo);
  const [tiersPermitidos, setTiersPermitidos] = useState<string[]>(
    recurso.tiers_permitidos ?? []
  );
  const [horarios, setHorarios] = useState<BloqueHorario[]>(() =>
    parseHorarios(recurso.horarios)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);

    const { error: err } = await updateRecurso(recurso.id, {
      nombre,
      descripcion: descripcion || null,
      activo,
      tiers_permitidos: tiersPermitidos,
      horarios: horarios as never
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
        <p className="ek-eyebrow ek-eyebrow--mustard">EDITAR ESTUDIO</p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>{recurso.nombre}</h3>

        <label className="ek-label">
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
          />
        </label>

        <label className="ek-label">
          Descripción
          <input
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            className="ek-input"
          />
        </label>

        <div className="ek-form-field">
          <label className="ek-label">Planes con acceso a este estudio</label>
          <MultiSelectTiers
            options={tiersDisponibles}
            value={tiersPermitidos}
            onChange={setTiersPermitidos}
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Solo los miembros con estos planes podrán reservar este estudio.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '12px' }}>
          <Toggle
            checked={activo}
            onChange={setActivo}
            label="Estudio activo"
            description="Si está inactivo, no aparece en la lista de reservables del miembro."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Horarios de operación</label>
          <HorariosEditor value={horarios} onChange={setHorarios} />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Define los días y horas en que este estudio puede reservarse.
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
          <button
            onClick={handleSave}
            disabled={saving}
            className="ek-cta"
            style={{ flex: 1 }}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function HorariosEditor({
  value,
  onChange
}: {
  value: BloqueHorario[];
  onChange: (v: BloqueHorario[]) => void;
}) {
  const getBloqueDia = (diaKey: string) => value.find((b) => b.dia === diaKey);

  const toggleDia = (diaKey: string) => {
    const existe = getBloqueDia(diaKey);
    if (existe) {
      onChange(value.filter((b) => b.dia !== diaKey));
    } else {
      onChange([...value, { dia: diaKey, inicio: '09:00', fin: '22:00' }]);
    }
  };

  const updateDia = (diaKey: string, campo: 'inicio' | 'fin', val: string) => {
    onChange(value.map((b) => (b.dia === diaKey ? { ...b, [campo]: val } : b)));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '16px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {DIAS.map((dia) => {
        const bloque = getBloqueDia(dia.key);
        const abierto = !!bloque;

        return (
          <div
            key={dia.key}
            style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 1fr 90px',
              gap: '12px',
              alignItems: 'center',
              padding: '10px 12px',
              background: abierto ? 'var(--ek-bg-elevated)' : 'transparent',
              borderRadius: 'var(--ek-r-sm)',
              transition: 'background 0.18s ease'
            }}
          >
            <span
              style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '14px',
                fontWeight: 600,
                color: abierto ? 'var(--ek-ink)' : 'var(--ek-ink-faint)'
              }}
            >
              {dia.label}
            </span>

            {abierto && bloque ? (
              <>
                <input
                  type="time"
                  className="ek-input"
                  value={bloque.inicio}
                  onChange={(e) => updateDia(dia.key, 'inicio', e.target.value)}
                  style={{ fontSize: '13px', padding: '8px 10px' }}
                />
                <input
                  type="time"
                  className="ek-input"
                  value={bloque.fin}
                  onChange={(e) => updateDia(dia.key, 'fin', e.target.value)}
                  style={{ fontSize: '13px', padding: '8px 10px' }}
                />
              </>
            ) : (
              <span
                style={{
                  gridColumn: '2 / 4',
                  fontSize: '12px',
                  color: 'var(--ek-ink-faint)',
                  fontStyle: 'italic'
                }}
              >
                Cerrado
              </span>
            )}

            <button
              type="button"
              onClick={() => toggleDia(dia.key)}
              className="ek-icon-btn"
              style={{
                padding: '6px 10px',
                fontSize: '11px',
                color: abierto ? 'var(--ek-danger)' : 'var(--ek-mustard)',
                width: '100%'
              }}
            >
              {abierto ? 'Cerrar' : 'Abrir'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function MultiSelectTiers({
  options,
  value,
  onChange
}: {
  options: TierOption[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (slug: string) => {
    if (value.includes(slug)) {
      onChange(value.filter((s) => s !== slug));
    } else {
      onChange([...value, slug]);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '12px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {options.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)' }}>
          No hay planes configurados.
        </p>
      ) : (
        options.map((opt) => {
          const selected = value.includes(opt.slug);
          return (
            <button
              key={opt.slug}
              type="button"
              onClick={() => toggle(opt.slug)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                background: selected ? 'var(--ek-mustard-soft)' : 'var(--ek-bg-elevated)',
                border: `0.5px solid ${selected ? 'var(--ek-mustard)' : 'var(--ek-line)'}`,
                borderRadius: 'var(--ek-r-md)',
                color: selected ? 'var(--ek-mustard)' : 'var(--ek-ink)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.18s ease'
              }}
            >
              <span style={{ fontSize: '14px' }}>{selected ? '✓' : '○'}</span>
              {opt.nombre}
            </button>
          );
        })
      )}
    </div>
  );
}
