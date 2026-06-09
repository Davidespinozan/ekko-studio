import { useParams, Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ImageIcon, Users, SearchX } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { TierBadge } from '@shared/components/TierBadge';
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
        toast.warning('No pudimos cargar el estudio · Intentá refrescar');
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

  const esPro = recurso.tiers_permitidos.length === 1 && recurso.tiers_permitidos[0] === 'pro';
  const usuarioPuedeUsar = usuario?.membresia_tier
    ? recurso.tiers_permitidos.includes(usuario.membresia_tier)
    : false;
  const tipoContenido = recurso.tipo_contenido ?? [];
  const equipo = recurso.equipo_incluido ?? [];

  return (
    <div className="ek-container">
      <button
        onClick={() => navigate(-1)}
        className="ek-icon-btn"
        style={{ marginBottom: '16px', width: 'auto', padding: '8px 14px', fontSize: '13px', gap: '6px' }}
      >
        <ArrowLeft size={15} aria-hidden="true" /> Volver
      </button>

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

        <TierBadge pro={esPro} style={{ position: 'absolute', top: '16px', left: '16px' }} />
      </div>

      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: "8px" }}>ESTUDIO</p>
        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(32px, 8vw, 48px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.05,
          margin: 0
        }}>{recurso.nombre}</h1>
        {recurso.descripcion && (
          <p className="ek-body" style={{ marginTop: '12px', color: 'var(--ek-ink-muted)' }}>
            {recurso.descripcion}
          </p>
        )}
      </div>

      {tipoContenido.length > 0 && (
        <div style={{ marginBottom: '32px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>IDEAL PARA</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {tipoContenido.map((tipo) => (
              <span key={tipo} className="ek-badge ek-badge--neutral" style={{ padding: '8px 14px' }}>
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
        {usuarioPuedeUsar ? (
          <Link
            to={`/app/reservar?recurso=${recurso.slug}`}
            className="ek-cta ek-cta--full"
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
              PLAN PRO REQUERIDO
            </p>
            <p className="ek-body" style={{ marginBottom: '14px' }}>
              Tu plan actual no incluye acceso a este estudio.
            </p>
            <Link to="/app/perfil" className="ek-cta">
              Ver mi plan
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
