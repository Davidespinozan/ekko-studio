import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowRight, ImageIcon } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useToast } from '@shared/hooks/useToast';
import { TierBadge } from '@shared/components/TierBadge';
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
      <div style={{ marginBottom: '24px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '12px' }}>EXPLORAR</p>
        <h1 className="ek-display-xl">Nuestros estudios</h1>
        <p className="ek-body-muted" style={{ marginTop: '8px' }}>
          Espacios profesionales diseñados para creadores. Cada uno con su personalidad.
        </p>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
        gap: '16px'
      }}>
        {recursos.map((r) => {
          const esPro = r.tiers_permitidos.length === 1 && r.tiers_permitidos[0] === 'pro';
          const tiposContenido = r.tipo_contenido ?? [];
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

                <TierBadge pro={esPro} style={{ position: 'absolute', top: '12px', left: '12px' }} />
              </div>

              <div style={{
                padding: '18px',
                background: 'linear-gradient(160deg, #faf7ef 0%, #ece4d2 100%)',
                color: 'var(--ek-bg)'
              }}>
                <h3 style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '20px',
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  margin: 0,
                  marginBottom: '6px',
                  color: 'var(--ek-bg)'
                }}>{r.nombre}</h3>

                {r.descripcion && (
                  <p style={{
                    fontSize: '13px',
                    color: 'rgba(10, 10, 10, 0.6)',
                    margin: 0,
                    marginBottom: '14px',
                    lineHeight: 1.4
                  }}>{r.descripcion}</p>
                )}

                {tiposContenido.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
                    {tiposContenido.slice(0, 3).map((tipo) => (
                      <span key={tipo} style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        padding: '4px 10px',
                        borderRadius: 'var(--ek-r-pill)',
                        background: 'rgba(10, 10, 10, 0.06)',
                        color: 'rgba(10, 10, 10, 0.6)',
                        border: '0.5px solid rgba(10, 10, 10, 0.12)'
                      }}>
                        {tipo}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '12px',
                  color: 'rgba(10, 10, 10, 0.55)'
                }}>
                  <span>
                    {(r.capacidad_personas ?? 0) > 0
                      ? `Hasta ${r.capacidad_personas} personas`
                      : 'Capacidad por confirmar'}
                  </span>
                  <span style={{ color: '#9a7b16', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    Ver detalle <ArrowRight size={13} aria-hidden="true" />
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
