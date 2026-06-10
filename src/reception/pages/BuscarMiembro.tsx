import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Search, UserX } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { EmptyState } from '@shared/components/EmptyState';
import { TierBadge } from '@shared/components/TierBadge';
import { statusMiembro } from '../lib/miembroStatus';

interface MiembroResultado {
  id: string;
  nombre: string | null;
  email: string;
  status: string;
  membresia_tier: string | null;
}

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
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Búsqueda del padrón de miembros para recepción.
 * Trae los miembros del tenant una vez y filtra en cliente: así la búsqueda
 * es instantánea e INSENSIBLE a acentos y mayúsculas (José ↔ jose), que con
 * ilike de Postgres no se lograba.
 */
export default function BuscarMiembro() {
  const tenant = useTenant();
  const [query, setQuery] = useState('');
  const [todos, setTodos] = useState<MiembroResultado[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorCarga, setErrorCarga] = useState(false);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    setErrorCarga(false);
    supabase
      .from('usuarios')
      .select('id, nombre, email, status, membresia_tier')
      .eq('tenant_id', tenant.id)
      .eq('rol', 'miembro')
      .order('nombre', { ascending: true })
      .limit(1000)
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          console.error('[BuscarMiembro]', error);
          setErrorCarga(true);
          setTodos([]);
        } else {
          setTodos((data ?? []) as MiembroResultado[]);
        }
        setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [tenant.id]);

  const q = norm(query);
  const sinBusqueda = q.length < 2;
  const resultados = useMemo(() => {
    if (q.length < 2) return [];
    return todos
      .filter((m) => norm(m.nombre ?? '').includes(q) || norm(m.email).includes(q))
      .slice(0, 50);
  }, [q, todos]);

  return (
    <div className="rec-main">
      <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ margin: '0 0 12px' }}>
        BUSCAR MIEMBRO
      </p>

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
          hint="Revisá tu conexión y recargá la página."
          tone="danger"
        />
      ) : sinBusqueda ? (
        <EmptyState
          icon={Search}
          title="Buscá un miembro"
          hint="Ingresá nombre o email para ver su perfil."
          tone="neutral"
        />
      ) : isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="ek-skeleton"
              style={{ height: '64px', borderRadius: 'var(--ek-r-md)' }}
            />
          ))}
        </div>
      ) : resultados.length === 0 ? (
        <EmptyState
          icon={UserX}
          title="Sin coincidencias"
          hint="No se encontraron miembros que coincidan. Los miembros se dan de alta solos desde la web."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {resultados.map((m) => {
            const st = statusMiembro(m.status);
            return (
              <Link key={m.id} to={`/recepcion/miembros/${m.id}`} className="rec-miembro-card">
                <div className="rec-miembro-card-info">
                  <p className="rec-miembro-card-nombre">
                    {capitalizar(m.nombre) || m.email}
                  </p>
                  <p className="rec-miembro-card-email">{m.email}</p>
                </div>
                {(m.membresia_tier === 'pro' || m.membresia_tier === 'basica') && (
                  <TierBadge
                    pro={m.membresia_tier === 'pro'}
                    style={{ flexShrink: 0 }}
                  />
                )}
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
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
