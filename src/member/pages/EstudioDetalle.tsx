import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ImageIcon, Users, SearchX } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { EmptyState } from '@shared/components/EmptyState';
import type { Database } from '@shared/types/database';

type RecursoDetalle = Database['public']['Tables']['recursos']['Row'];

export default function EstudioDetalle() {
  const { slug } = useParams<{ slug: string }>();
  const tenant = useTenant();
  const { usuario } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [recurso, setRecurso] = useState<RecursoDetalle | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    let mounted = true;
    async function load() {
      const { data, error } = await supabase
        .from('recursos')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('slug', slug!)
        .eq('activo', true)
        .maybeSingle();

      if (!mounted) return;
      if (error) {
        console.error('[EstudioDetalle]', error);
        toast.warning('No pudimos cargar el estudio · Intenta refrescar');
      } else {
        setRecurso(data);
      }
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [slug, tenant.id, toast]);

  if (isLoading) {
    return (
      <div className="ek-container">
        <div className="ek-skeleton" style={{ height: '500px', borderRadius: 'var(--ek-r-card)' }} />
      </div>
    );
  }

  if (!recurso) {
    return (
      <div className="ek-container">
        <EmptyState
          icon={SearchX}
          tone="neutral"
          title="Estudio no encontrado"
          hint="El estudio que buscás no existe o ya no está disponible."
          action={<Link to="/app/estudios" className="ek-cta">Ver todos los estudios</Link>}
        />
      </div>
    );
  }

  // Modelo de créditos plano: cualquier plan puede reservar cualquier estudio.
  // El freno es solo "tener plan"; ver el estudio es libre.
  const tienePlan = !!usuario?.membresia_tier;
  const tipoContenido = recurso.tipo_contenido ?? [];
  const equipo = recurso.equipo_incluido ?? [];

  return (
    <div className="ek-container">
      {/* Header row: Volver a la izquierda, nombre del estudio centrado. */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '34px', marginBottom: '14px' }}>
        <button
          onClick={() => navigate(-1)}
          style={{ position: 'absolute', left: 0, display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none', color: 'var(--ek-ink-muted)', fontSize: '13px', cursor: 'pointer', padding: '2px 0' }}
        >
          <ArrowLeft size={15} aria-hidden="true" /> Volver
        </button>
        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '19px',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          margin: 0,
          textAlign: 'center',
          maxWidth: '58%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}>{recurso.nombre}</h1>
      </div>

      {/* Foto grande */}
      <div style={{
        background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
        aspectRatio: '16 / 9',
        borderRadius: 'var(--ek-r-card)',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '24px',
        overflow: 'hidden',
        border: '0.5px solid var(--ek-line)'
      }}>
        {recurso.foto_url ? (
          <img
            src={recurso.foto_url}
            alt={recurso.nombre}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', color: 'var(--ek-ink-faint)' }}>
            <ImageIcon size={30} strokeWidth={1.5} aria-hidden="true" />
            <span style={{ fontSize: '11px', letterSpacing: '0.2em', fontWeight: 600 }}>FOTO PRÓXIMAMENTE</span>
          </div>
        )}
      </div>

      {recurso.descripcion && (
        <p className="ek-body" style={{ marginBottom: '20px', color: 'var(--ek-ink-muted)' }}>
          {recurso.descripcion}
        </p>
      )}

      {tipoContenido.length > 0 && (
        <div className="ek-card ek-card--md ek-card--cream" style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(10, 10, 10, 0.45)', margin: 0, flexShrink: 0 }}>
            IDEAL PARA
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {tipoContenido.map((tipo) => (
              <span key={tipo} style={{
                padding: '5px 11px',
                borderRadius: '999px',
                background: 'rgba(229, 184, 41, 0.22)',
                color: 'var(--ek-bg)',
                fontSize: '10.5px',
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase'
              }}>
                {tipo}
              </span>
            ))}
          </div>
        </div>
      )}

      {(recurso.capacidad_personas ?? 0) > 0 && (
        <div className="ek-stat-card ek-stat-card--accent" style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span className="ek-empty-icon" style={{ width: 48, height: 48, margin: 0 }}>
            <Users size={20} aria-hidden="true" />
          </span>
          <div>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>CAPACIDAD</p>
            <p className="ek-kpi">
              {recurso.capacidad_personas}{' '}
              <span style={{
                fontSize: '15px',
                fontWeight: 500,
                color: 'var(--ek-ink-muted)',
                letterSpacing: 'normal'
              }}>personas</span>
            </p>
          </div>
        </div>
      )}

      {equipo.length > 0 && (
        <div className="ek-card" style={{ marginBottom: '24px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>
            EQUIPO INCLUIDO
          </p>
          <ul style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}>
            {equipo.map((item) => (
              <li
                key={item}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  fontSize: '14px',
                  color: 'var(--ek-ink)'
                }}
              >
                <Check size={16} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recurso.estilo_visual && (
        <div className="ek-card" style={{ marginBottom: '24px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>ESTILO</p>
          <p className="ek-body" style={{ lineHeight: 1.6 }}>
            {recurso.estilo_visual}
          </p>
        </div>
      )}

      <div style={{ marginBottom: '24px' }}>
        {tienePlan ? (
          <Link
            to={`/app/reservar?recurso=${recurso.slug}`}
            className="ek-cta ek-cta--gold ek-cta--full"
            style={{ minHeight: '52px', fontSize: '15px' }}
          >
            Reservar este estudio <ArrowRight size={17} aria-hidden="true" />
          </Link>
        ) : (
          <div className="ek-card" style={{
            borderColor: 'var(--ek-mustard-dim)',
            background: 'var(--ek-mustard-soft)',
            textAlign: 'center'
          }}>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
              NECESITAS UN PLAN
            </p>
            <p className="ek-body" style={{ marginBottom: '14px' }}>
              Necesitas un plan para reservar. Puedes explorar los estudios mientras tanto.
            </p>
            <Link to="/app/perfil" className="ek-cta ek-cta--gold">
              Ver planes
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
