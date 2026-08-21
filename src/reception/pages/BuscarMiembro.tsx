import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Search, UserX, ShieldAlert, UserPlus } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { EmptyState } from '@shared/components/EmptyState';
import { SegmentedToggle } from '@shared/components/SegmentedToggle';
import { PlanChip } from '@shared/components/PlanChip';
import { usePlanesActivos } from '@shared/hooks/usePlanesActivos';
import { statusMiembro } from '../lib/miembroStatus';
import { RegistrarMiembroModal } from '../components/RegistrarMiembroModal';
import { ZONA_ESTUDIO } from '@shared/lib/timezone';

interface MiembroResultado {
  id: string;
  nombre: string | null;
  email: string;
  status: string;
  membresia_tier: string | null;
  bloqueado_hasta: string | null;
}

type Modo = 'buscar' | 'penalizados';

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Normaliza para comparar: minúsculas + sin acentos. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', { timeZone: ZONA_ESTUDIO, day: 'numeric', month: 'short' });
}

/**
 * Búsqueda del padrón de miembros para recepción.
 * Trae los miembros del tenant una vez y filtra en cliente: así la búsqueda
 * es instantánea e INSENSIBLE a acentos y mayúsculas (José ↔ jose), que con
 * ilike de Postgres no se lograba.
 *
 * Modo "Penalizados" (Bloque D): lista los miembros con bloqueo activo
 * (bloqueado_hasta > now). Tap → perfil, donde está el desbloqueo (Bloque A).
 */
export default function BuscarMiembro() {
  const tenant = useTenant();
  const [modo, setModo] = useState<Modo>('buscar');
  const [query, setQuery] = useState('');
  const [todos, setTodos] = useState<MiembroResultado[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCarga, setErrorCarga] = useState(false);
  const [registrarOpen, setRegistrarOpen] = useState(false);

  const cargarPadron = useCallback(async () => {
    setIsLoading(true);
    setErrorCarga(false);
    const { data, error } = await supabase
      .from('usuarios')
      .select('id, nombre, email, status, membresia_tier, bloqueado_hasta')
      .eq('tenant_id', tenant.id)
      .eq('rol', 'miembro')
      .order('nombre', { ascending: true })
      .limit(1000);
    if (error) {
      console.error('[BuscarMiembro]', error);
      setErrorCarga(true);
      setTodos([]);
    } else {
      setTodos((data ?? []) as MiembroResultado[]);
    }
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void cargarPadron();
  }, [cargarPadron]);

  // Tras registrar: recargar el padrón y pre-cargar el email en la búsqueda
  // para ubicar al miembro nuevo (que nace pendiente_pago).
  async function handleRegistrado(email: string) {
    setRegistrarOpen(false);
    setModo('buscar');
    setQuery(email);
    await cargarPadron();
  }

  // Planes activos: para NO mostrar chips de planes borrados (pro/basica viejos).
  const { planes } = usePlanesActivos();
  const planesActivos = useMemo(() => new Set(planes.map((p) => p.slug)), [planes]);

  const q = norm(query);
  const buscando = q.length >= 2;
  // Por defecto se muestra TODO el padrón; al escribir se filtra.
  const resultados = useMemo(() => {
    const base = buscando
      ? todos.filter((m) => norm(m.nombre ?? '').includes(q) || norm(m.email).includes(q))
      : todos;
    return base.slice(0, 100);
  }, [q, buscando, todos]);

  const penalizados = useMemo(() => {
    const now = Date.now();
    return todos.filter(
      (m) => m.bloqueado_hasta != null && new Date(m.bloqueado_hasta).getTime() > now
    );
  }, [todos]);

  return (
    <div className="rec-main">
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
        <button
          type="button"
          onClick={() => setRegistrarOpen(true)}
          className="ek-cta ek-cta--gold"
          style={{ minHeight: '44px', padding: '0 16px', fontSize: '13px', flexShrink: 0 }}
        >
          <UserPlus size={16} aria-hidden="true" /> Registrar
        </button>
      </div>

      {/* Toggle Buscar / Penalizados (Bloque D) */}
      <div style={{ marginBottom: '16px' }}>
        <SegmentedToggle
          block
          ariaLabel="Modo de miembros"
          value={modo}
          onChange={setModo}
          options={[
            { value: 'buscar', label: 'Buscar' },
            { value: 'penalizados', label: `Penalizados${penalizados.length ? ` (${penalizados.length})` : ''}` }
          ]}
        />
      </div>

      {modo === 'buscar' ? (
        <>
          <div style={{ position: 'relative', marginBottom: '20px' }}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nombre o email del miembro…"
              className="ek-input"
              style={{ paddingRight: query ? '52px' : undefined, minHeight: '44px' }}
              aria-label="Buscar miembro"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                style={{
                  position: 'absolute',
                  top: '50%',
                  right: '4px',
                  transform: 'translateY(-50%)',
                  width: '44px',
                  height: '44px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--ek-ink-muted)',
                  cursor: 'pointer',
                  lineHeight: 1
                }}
              >
                <X size={18} aria-hidden="true" />
              </button>
            )}
          </div>

          {errorCarga ? (
            <EmptyState
              icon={UserX}
              title="No pudimos cargar el padrón"
              hint="Revisa tu conexión y recargá la página."
              tone="danger"
            />
          ) : isLoading ? (
            <ListaSkeleton />
          ) : resultados.length === 0 ? (
            <EmptyState
              icon={buscando ? Search : UserX}
              title={buscando ? 'Sin coincidencias' : 'Sin miembros todavía'}
              hint={buscando
                ? 'No se encontraron miembros que coincidan. Los miembros se dan de alta solos desde la web.'
                : 'Cuando registres o se den de alta miembros, aparecerán aquí.'}
              tone="neutral"
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {resultados.map((m) => (
                <MiembroCard key={m.id} miembro={m} planesActivos={planesActivos} />
              ))}
            </div>
          )}
        </>
      ) : errorCarga ? (
        <EmptyState
          icon={UserX}
          title="No pudimos cargar el padrón"
          hint="Revisa tu conexión y recargá la página."
          tone="danger"
        />
      ) : isLoading ? (
        <ListaSkeleton />
      ) : penalizados.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="Sin miembros penalizados"
          hint="Cuando un miembro acumule inasistencias y quede bloqueado, aparecerá aquí."
          tone="neutral"
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {penalizados.map((m) => (
            <MiembroCard key={m.id} miembro={m} planesActivos={planesActivos} mostrarBloqueo />
          ))}
        </div>
      )}

      {registrarOpen && (
        <RegistrarMiembroModal
          onClose={() => setRegistrarOpen(false)}
          onRegistrado={handleRegistrado}
        />
      )}
    </div>
  );
}

function ListaSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="ek-skeleton" style={{ height: '64px', borderRadius: 'var(--ek-r-md)' }} />
      ))}
    </div>
  );
}

function MiembroCard({ miembro, planesActivos, mostrarBloqueo }: { miembro: MiembroResultado; planesActivos?: Set<string>; mostrarBloqueo?: boolean }) {
  const st = statusMiembro(miembro.status);
  // Solo mostramos el plan si sigue ACTIVO (no los tiers borrados tipo pro/basica).
  const planVigente = miembro.membresia_tier && planesActivos?.has(miembro.membresia_tier);
  return (
    <Link to={`/recepcion/miembros/${miembro.id}`} className="rec-miembro-card">
      <div className="rec-miembro-card-info">
        <p className="rec-miembro-card-nombre">{capitalizar(miembro.nombre) || miembro.email}</p>
        <p className="rec-miembro-card-email">{miembro.email}</p>
      </div>
      {planVigente ? (
        <PlanChip slug={miembro.membresia_tier} style={{ flexShrink: 0 }} />
      ) : null}
      {mostrarBloqueo && miembro.bloqueado_hasta ? (
        <span
          className="ek-badge"
          style={{
            backgroundColor: 'var(--ek-danger)',
            color: 'var(--ek-bg)',
            fontSize: '10px',
            fontWeight: 700,
            flexShrink: 0
          }}
        >
          HASTA {fechaCorta(miembro.bloqueado_hasta)}
        </span>
      ) : (
        <span
          className="ek-badge"
          style={{
            backgroundColor: st.color,
            color: 'var(--ek-bg)',
            fontSize: '10px',
            fontWeight: 700,
            flexShrink: 0
          }}
        >
          {st.label}
        </span>
      )}
    </Link>
  );
}
