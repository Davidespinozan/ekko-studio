import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useRecursosAdmin, updateRecurso, insertRecurso } from '../hooks/useAdminData';
import { archiveRecord, restoreRecord, generateUniqueSlug } from '../lib/crudHelpers';
import Toggle from '../components/Toggle';
import ImageUploader from '../components/ImageUploader';
import ConfirmDialog from '../components/ConfirmDialog';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];
type RecursoInsert = Database['public']['Tables']['recursos']['Insert'];

// Estado del modal: 'edit' lleva una fila existente; 'create' lleva los defaults.
type ModalState =
  | { mode: 'edit'; recurso: Recurso }
  | { mode: 'create' }
  | null;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

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
  const tenant = useTenant();
  const { recursos, isLoading, refetch } = useRecursosAdmin();
  const [modal, setModal] = useState<ModalState>(null);
  const [archivando, setArchivando] = useState<Recurso | null>(null);
  const [mostrarArchivados, setMostrarArchivados] = useState(false);
  const [duplicandoId, setDuplicandoId] = useState<string | null>(null);
  const [restaurandoId, setRestaurandoId] = useState<string | null>(null);

  const { activos, archivados } = useMemo(() => {
    return {
      activos: recursos.filter((r) => r.activo),
      archivados: recursos.filter((r) => !r.activo)
    };
  }, [recursos]);

  async function handleDuplicar(original: Recurso) {
    setDuplicandoId(original.id);
    const existingSlugs = recursos.map((r) => r.slug);
    const nuevoSlug = generateUniqueSlug(original.slug, existingSlugs);

    const payload: RecursoInsert = {
      tenant_id: tenant.id,
      slug: nuevoSlug,
      nombre: `(copia) ${original.nombre}`,
      descripcion: original.descripcion,
      tipo: original.tipo,
      cupos: original.cupos,
      capacidad_personas: original.capacidad_personas,
      horarios: original.horarios,
      tiers_permitidos: original.tiers_permitidos,
      equipo_incluido: original.equipo_incluido,
      tipo_contenido: original.tipo_contenido,
      estilo_visual: original.estilo_visual,
      foto_url: null, // no copiar la foto (puede confundir; admin sube nueva si quiere)
      activo: true,
      orden: (original.orden ?? 0) + 1
    };

    const { error } = await insertRecurso(payload);
    setDuplicandoId(null);
    if (error) {
      alert(`No se pudo duplicar: ${error}`);
      return;
    }
    await refetch();
  }

  async function handleArchivar() {
    if (!archivando) return;
    const { error } = await archiveRecord('recursos', archivando.id);
    if (error) {
      alert(`No se pudo archivar: ${error}`);
      return;
    }
    setArchivando(null);
    await refetch();
  }

  async function handleRestaurar(r: Recurso) {
    setRestaurandoId(r.id);
    const { error } = await restoreRecord('recursos', r.id);
    setRestaurandoId(null);
    if (error) {
      alert(`No se pudo restaurar: ${error}`);
      return;
    }
    await refetch();
  }

  return (
    <div className="adm-page">
      <div
        className="adm-page-header"
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <div>
          <p className="ek-eyebrow">ESTUDIOS</p>
          <h1 className="ek-h2">Recursos reservables</h1>
        </div>
        <button onClick={() => setModal({ mode: 'create' })} className="ek-cta">
          + Nuevo estudio
        </button>
      </div>

      {isLoading ? (
        <p className="adm-body">Cargando…</p>
      ) : (
        <>
          <div className="adm-stack">
            {activos.length === 0 ? (
              <p className="ek-body-faint" style={{ padding: '20px 0' }}>
                No hay estudios activos. Click en &quot;+ Nuevo estudio&quot; para crear el primero.
              </p>
            ) : (
              activos.map((r) => (
                <RecursoRow
                  key={r.id}
                  recurso={r}
                  onEdit={() => setModal({ mode: 'edit', recurso: r })}
                  onDuplicate={() => handleDuplicar(r)}
                  onArchive={() => setArchivando(r)}
                  duplicating={duplicandoId === r.id}
                />
              ))
            )}
          </div>

          {archivados.length > 0 && (
            <section style={{ marginTop: '32px' }}>
              <button
                type="button"
                onClick={() => setMostrarArchivados((v) => !v)}
                className="ek-icon-btn"
                style={{
                  width: 'auto',
                  padding: '8px 14px',
                  fontSize: '12px',
                  marginBottom: '12px'
                }}
              >
                {mostrarArchivados ? '▾' : '▸'} Ver archivados ({archivados.length})
              </button>

              {mostrarArchivados && (
                <div className="adm-stack" style={{ opacity: 0.6 }}>
                  {archivados.map((r) => (
                    <RecursoArchivedRow
                      key={r.id}
                      recurso={r}
                      onRestore={() => handleRestaurar(r)}
                      restoring={restaurandoId === r.id}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {modal?.mode === 'edit' && (
        <EditarRecursoModal
          recurso={modal.recurso}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}

      {modal?.mode === 'create' && (
        <EditarRecursoModal
          recurso={null}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refetch();
            setModal(null);
          }}
        />
      )}

      <ConfirmDialog
        isOpen={archivando !== null}
        title={archivando ? `¿Archivar “${archivando.nombre}”?` : ''}
        description="Este estudio dejará de aparecer en la landing y no se podrá reservar. Las reservas históricas no se afectan. Puedes restaurarlo después."
        confirmLabel="Archivar"
        variant="warning"
        onConfirm={handleArchivar}
        onCancel={() => setArchivando(null)}
      />
    </div>
  );
}

function RecursoRow({
  recurso: r,
  onEdit,
  onDuplicate,
  onArchive,
  duplicating
}: {
  recurso: Recurso;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  duplicating: boolean;
}) {
  return (
    <div className="ek-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem'
        }}
      >
        <div style={{ flex: 1 }}>
          <h3 className="ek-h3">{r.nombre}</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
            Cupos: {r.cupos}
            {r.capacidad_personas ? ` · Capacidad: ${r.capacidad_personas}` : ''}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '120px' }}>
          <button onClick={onEdit} className="ek-icon-btn" style={{ width: '100%', padding: '8px 12px', fontSize: '12px' }}>
            ✏️ Editar
          </button>
          <button
            onClick={onDuplicate}
            disabled={duplicating}
            className="ek-icon-btn"
            style={{ width: '100%', padding: '8px 12px', fontSize: '12px' }}
          >
            {duplicating ? 'Duplicando…' : '📋 Duplicar'}
          </button>
          <button
            onClick={onArchive}
            className="ek-icon-btn"
            style={{ width: '100%', padding: '8px 12px', fontSize: '12px', color: 'var(--ek-danger)' }}
          >
            🗄 Archivar
          </button>
        </div>
      </div>
    </div>
  );
}

function RecursoArchivedRow({
  recurso: r,
  onRestore,
  restoring
}: {
  recurso: Recurso;
  onRestore: () => void;
  restoring: boolean;
}) {
  return (
    <div className="ek-card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem'
        }}
      >
        <div>
          <h3 className="ek-h3" style={{ textDecoration: 'line-through' }}>{r.nombre}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-faint)' }}>
            Archivado · slug: {r.slug}
          </p>
        </div>
        <button
          onClick={onRestore}
          disabled={restoring}
          className="ek-icon-btn"
          style={{ padding: '8px 14px', fontSize: '12px' }}
        >
          {restoring ? 'Restaurando…' : '♻️ Restaurar'}
        </button>
      </div>
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
  recurso: Recurso | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const tenant = useTenant();
  const tiersDisponibles = useTiersDelTenant();
  const esCreacion = recurso === null;

  const [nombre, setNombre] = useState(recurso?.nombre ?? '');
  const [slug, setSlug] = useState(recurso?.slug ?? '');
  const [slugTocado, setSlugTocado] = useState(!esCreacion);
  const [descripcion, setDescripcion] = useState(recurso?.descripcion ?? '');
  const [activo, setActivo] = useState(recurso?.activo ?? true);
  const [tiersPermitidos, setTiersPermitidos] = useState<string[]>(
    recurso?.tiers_permitidos ?? []
  );
  const [horarios, setHorarios] = useState<BloqueHorario[]>(() =>
    parseHorarios(recurso?.horarios)
  );
  const [fotoUrl, setFotoUrl] = useState<string>(recurso?.foto_url ?? '');
  const [capacidadPersonas, setCapacidadPersonas] = useState<number>(
    recurso?.capacidad_personas ?? 0
  );
  const [tipoContenido, setTipoContenido] = useState<string[]>(recurso?.tipo_contenido ?? []);
  const [equipoIncluido, setEquipoIncluido] = useState<string[]>(recurso?.equipo_incluido ?? []);
  const [estiloVisual, setEstiloVisual] = useState<string>(recurso?.estilo_visual ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Slug auto-derivado del nombre en modo crear, hasta que el admin lo edite manualmente
  useEffect(() => {
    if (esCreacion && !slugTocado) {
      setSlug(slugify(nombre));
    }
  }, [nombre, esCreacion, slugTocado]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    if (esCreacion) {
      if (!nombre.trim()) {
        setError('El nombre es obligatorio.');
        setSaving(false);
        return;
      }
      const slugFinal = slug.trim() || slugify(nombre);
      if (!/^[a-z0-9-]+$/.test(slugFinal)) {
        setError('El slug solo puede contener letras minúsculas, números y guiones.');
        setSaving(false);
        return;
      }

      const { error: err } = await insertRecurso({
        tenant_id: tenant.id,
        slug: slugFinal,
        nombre: nombre.trim(),
        descripcion: descripcion || null,
        tipo: 'estudio_individual',
        cupos: 1,
        activo,
        tiers_permitidos: tiersPermitidos,
        horarios: horarios as never,
        foto_url: fotoUrl || null,
        capacidad_personas: capacidadPersonas || null,
        tipo_contenido: tipoContenido,
        equipo_incluido: equipoIncluido,
        estilo_visual: estiloVisual || null
      });

      if (err) {
        setError(err);
        setSaving(false);
        return;
      }
      await onSaved();
      return;
    }

    // Edit mode
    const { error: err } = await updateRecurso(recurso!.id, {
      nombre,
      descripcion: descripcion || null,
      activo,
      tiers_permitidos: tiersPermitidos,
      horarios: horarios as never,
      foto_url: fotoUrl || null,
      capacidad_personas: capacidadPersonas || null,
      tipo_contenido: tipoContenido,
      equipo_incluido: equipoIncluido,
      estilo_visual: estiloVisual || null
    });

    if (err) {
      setError(err);
      setSaving(false);
      return;
    }
    await onSaved();
  }

  // Path prefix para upload de foto: usa el slug si existe, sino "nuevo-{timestamp}".
  // En modo crear, si el admin sube foto antes de tener slug definitivo, no se mueve.
  const photoSlug = slug || `nuevo-${Date.now()}`;

  return (
    <div className="adm-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
        <p className="ek-eyebrow ek-eyebrow--mustard">
          {esCreacion ? 'NUEVO ESTUDIO' : 'EDITAR ESTUDIO'}
        </p>
        <h3 className="ek-h3" style={{ marginBottom: '1rem' }}>
          {nombre || 'Sin nombre'}
        </h3>

        <label className="ek-label">
          Nombre
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="ek-input"
            placeholder="Ej: Estudio 1"
          />
        </label>

        {esCreacion && (
          <div className="ek-form-field">
            <label className="ek-label">Slug (URL)</label>
            <input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTocado(true);
              }}
              className="ek-input"
              placeholder="estudio-1"
              pattern="[a-z0-9-]+"
            />
            <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
              Solo minúsculas, números y guiones. Identificador único, no editable luego.
            </p>
          </div>
        )}

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

        <div style={{ marginTop: '16px' }}>
          <ImageUploader
            bucket="estudios"
            pathPrefix={`${tenant.slug}/${photoSlug}`}
            currentUrl={fotoUrl || null}
            onUploaded={setFotoUrl}
            label="Foto del estudio"
            helperText="JPG, PNG o WEBP. Máx 5MB. Aspecto 16:10 recomendado."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Capacidad (personas)</label>
          <input
            type="number"
            min={1}
            max={20}
            value={capacidadPersonas || ''}
            onChange={(e) => setCapacidadPersonas(parseInt(e.target.value) || 0)}
            className="ek-input"
            placeholder="Ej: 3"
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Capacidad máxima total (titular + invitados).
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Tipos de contenido recomendados</label>
          <ListaEditable
            value={tipoContenido}
            onChange={setTipoContenido}
            placeholder="Ej: Podcast, Video, Entrevistas..."
          />
          <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            Tags que ayudan a los miembros a elegir el estudio adecuado.
          </p>
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Equipo incluido</label>
          <ListaEditable
            value={equipoIncluido}
            onChange={setEquipoIncluido}
            placeholder="Ej: Cámara Sony A7 IV..."
          />
        </div>

        <div className="ek-form-field" style={{ marginTop: '16px' }}>
          <label className="ek-label">Estilo visual</label>
          <textarea
            value={estiloVisual}
            onChange={(e) => setEstiloVisual(e.target.value)}
            className="ek-input"
            rows={3}
            placeholder="Describe el ambiente, iluminación, decoración..."
          />
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

function ListaEditable({
  value,
  onChange,
  placeholder
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [nuevo, setNuevo] = useState('');

  const agregar = () => {
    const trim = nuevo.trim();
    if (!trim) return;
    onChange([...value, trim]);
    setNuevo('');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        background: 'var(--ek-bg-soft)',
        borderRadius: 'var(--ek-r-md)',
        border: '0.5px solid var(--ek-line)'
      }}
    >
      {value.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {value.map((item, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 10px',
                background: 'var(--ek-bg-elevated)',
                borderRadius: 'var(--ek-r-sm)'
              }}
            >
              <span style={{ color: 'var(--ek-mustard)', fontSize: '12px' }}>✓</span>
              <span style={{ flex: 1, fontSize: '13px' }}>{item}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== idx))}
                className="ek-icon-btn"
                style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--ek-danger)' }}
                aria-label="Eliminar"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          type="text"
          placeholder={placeholder}
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
          style={{ padding: '8px 14px', fontSize: '12px', whiteSpace: 'nowrap' }}
        >
          + Agregar
        </button>
      </div>
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
