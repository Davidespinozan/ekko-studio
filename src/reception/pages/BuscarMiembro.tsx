import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { statusMiembro } from '../lib/miembroStatus';
import { RegistrarMiembroModal } from '../components/RegistrarMiembroModal';

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

/**
 * Búsqueda del padrón de miembros para recepción (RP-2).
 * Recepción ya lee `usuarios` del tenant vía RLS — sin backend nuevo.
 */
export default function BuscarMiembro() {
  const tenant = useTenant();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [resultados, setResultados] = useState<MiembroResultado[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showRegistrar, setShowRegistrar] = useState(false);

  // Debounce del input (200ms, mismo criterio que la búsqueda de R1).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    // Sanitizar: comas y paréntesis rompen la sintaxis de .or(); % y _ son
    // wildcards de ilike. Los quitamos — nombres/emails no los usan.
    const safe = debounced.replace(/[,%()_]/g, '').trim();
    if (safe.length < 2) {
      setResultados([]);
      setIsLoading(false);
      return;
    }

    let mounted = true;
    setIsLoading(true);

    supabase
      .from('usuarios')
      .select('id, nombre, email, status, membresia_tier')
      .eq('tenant_id', tenant.id)
      .eq('rol', 'miembro')
      .or(`nombre.ilike.%${safe}%,email.ilike.%${safe}%`)
      .order('nombre', { ascending: true })
      .limit(30)
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) {
          console.error('[BuscarMiembro]', error);
          setResultados([]);
        } else {
          setResultados((data ?? []) as MiembroResultado[]);
        }
        setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [debounced, tenant.id]);

  const sinBusqueda = debounced.replace(/[,%()_]/g, '').trim().length < 2;

  return (
    <div className="rec-main">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '12px'
        }}
      >
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ margin: 0 }}>
          BUSCAR MIEMBRO
        </p>
        <button
          type="button"
          onClick={() => setShowRegistrar(true)}
          className="ek-cta"
          style={{
            minHeight: '44px',
            padding: '8px 16px',
            fontSize: '13px',
            flexShrink: 0,
            whiteSpace: 'nowrap'
          }}
        >
          + Registrar miembro
        </button>
      </div>

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
              fontSize: '16px',
              lineHeight: 1
            }}
          >
            ✕
          </button>
        )}
      </div>

      {sinBusqueda ? (
        <p className="ek-body-faint" style={{ padding: '24px 0', textAlign: 'center' }}>
          Buscá un miembro por nombre o email para ver su perfil.
        </p>
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
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <p className="ek-body-faint" style={{ marginBottom: '14px' }}>
            No se encontraron miembros que coincidan.
          </p>
          <button
            type="button"
            onClick={() => setShowRegistrar(true)}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '44px', padding: '10px 18px', fontSize: '13px' }}
          >
            ¿No lo encontrás? Registrá un miembro nuevo
          </button>
        </div>
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
                {m.membresia_tier && (
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: 'var(--ek-ink-muted)',
                      flexShrink: 0
                    }}
                  >
                    {m.membresia_tier}
                  </span>
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

      {showRegistrar && (
        <RegistrarMiembroModal
          onClose={() => setShowRegistrar(false)}
          onRegistrado={(email) => {
            setShowRegistrar(false);
            // Pre-cargar el email en la búsqueda: el nuevo miembro aparece
            // en resultados (con badge pendiente_pago). El backend no
            // devuelve el id, así que no se puede navegar directo al perfil.
            setQuery(email);
          }}
        />
      )}
    </div>
  );
}
