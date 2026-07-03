import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowRight, ImageIcon } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import type { Database } from '@shared/types/database';

type Recurso = Database['public']['Tables']['recursos']['Row'];

export default function Estudios() {
  const tenant = useTenant();
  const toast = useToast();
  const [recursos, setRecursos] = useState<Recurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('activo', true)
        .order('nombre');

      if (!mounted) return;
      if (error) {
        console.error('[Estudios]', error);
        toast.warning('No pudimos cargar los estudios · Intentá refrescar');
      } else {
        setRecursos(data ?? []);
      }
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [tenant.id, toast]);

  if (isLoading) {
    return (
      <div className="ek-container">
        <div className="ek-skeleton" style={{ height: '400px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  return (
    <div className="ek-container">
      <p className="ek-body-muted" style={{ margin: '4px 0 20px' }}>
        Espacios profesionales diseñados para creadores. Cada uno con su personalidad.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
        gap: '16px'
      }}>
        {recursos.map((r) => {
          return (
            <Link
              key={r.id}
              to={`/app/estudios/${r.slug}`}
              className="ek-card ek-card-interactive"
              style={{
                padding: 0,
                overflow: 'hidden',
                textDecoration: 'none',
                color: 'inherit',
                borderRadius: 'var(--ek-r-md)'
              }}
            >
              <div style={{
                background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
                aspectRatio: '16 / 10',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                {r.foto_url ? (
                  <img
                    src={r.foto_url}
                    alt={r.nombre}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover'
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: 'var(--ek-ink-faint)' }}>
                    <ImageIcon size={24} strokeWidth={1.5} aria-hidden="true" />
                    <span style={{ fontSize: '10px', letterSpacing: '0.18em', fontWeight: 600 }}>FOTO PRÓXIMAMENTE</span>
                  </div>
                )}
              </div>

              {/* Cuerpo compacto: la FOTO es la protagonista. Nombre y flecha en
                  una sola fila (la descripción va en el detalle). */}
              <div style={{
                padding: '12px 14px',
                background: 'var(--ek-bg-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px'
              }}>
                <h3 style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '18px',
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}>{r.nombre}</h3>
                <ArrowRight size={18} style={{ color: 'var(--ek-mustard)', flexShrink: 0 }} aria-hidden="true" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
