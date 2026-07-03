import { Link } from 'react-router-dom';
import { CalendarClock, ArrowRight, LogOut } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { MiSuscripcion } from '@member/components/MiSuscripcion';
import { ActivarAvisosPush } from '@member/components/ActivarAvisosPush';

export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();

  const nombreFormat = usuario?.nombre
    ?.toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') ?? '';

  const initials = (usuario?.nombre ?? usuario?.email ?? '?')
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

  return (
    <div className="ek-container">
      <div className="ek-stack-lg" style={{ paddingTop: '4px' }}>
        {/* Avatar + nombre + contacto sobre un badge crema (como el saludo del
            inicio) — le da un toque premium al header del perfil. */}
        <div className="ek-card ek-card--cream" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span className="ek-avatar-ring" style={{ flexShrink: 0 }}>
            {usuario?.avatar_url ? (
              <img
                src={usuario.avatar_url}
                alt={usuario.nombre ?? 'Avatar'}
                style={{ width: '72px', height: '72px', borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: '72px',
                height: '72px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--ek-bg-elevated), var(--ek-bg-soft))',
                color: 'var(--ek-mustard)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--ek-font-display)',
                fontSize: '26px',
                fontWeight: 700,
                letterSpacing: '-0.04em'
              }}>
                {initials}
              </div>
            )}
          </span>
          <div style={{ minWidth: 0 }}>
            <p style={{ margin: 0, fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--ek-bg)' }}>
              {nombreFormat || 'Tu cuenta'}
            </p>
            <p style={{ margin: '3px 0 0', wordBreak: 'break-word', fontSize: '13px', color: 'rgba(10, 10, 10, 0.6)' }}>{authUser?.email}</p>
            {usuario?.telefono && (
              <p style={{ margin: '1px 0 0', fontSize: '13px', color: 'rgba(10, 10, 10, 0.6)' }}>{usuario.telefono}</p>
            )}
          </div>
        </div>

        {/* Mi suscripción */}
        {usuario?.id && (
          <MiSuscripcion
            usuarioId={usuario.id}
            tierSlug={usuario.membresia_tier ?? null}
            status={usuario.status}
          />
        )}

        {/* Avisos push */}
        {usuario?.id && (
          <ActivarAvisosPush usuarioId={usuario.id} tenantId={tenant.id} />
        )}

        {/* Acceso a Mis reservas (próximas + historial viven en su página) */}
        <Link
          to="/app/reservas"
          className="ek-card ek-card--md ek-card-interactive ek-lift"
          style={{ display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}
        >
          <span className="ek-empty-icon" style={{ width: 44, height: 44, margin: 0, flexShrink: 0 }}>
            <CalendarClock size={20} aria-hidden="true" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
              Mis reservas
            </p>
            <p className="ek-body-faint" style={{ marginTop: '2px' }}>Próximas sesiones e historial</p>
          </div>
          <ArrowRight size={16} className="ek-quick-action-arrow" aria-hidden="true" />
        </Link>

        <button onClick={signOut} className="ek-cta ek-cta--secondary ek-cta--full">
          <LogOut size={16} aria-hidden="true" /> Cerrar sesión
        </button>
      </div>
    </div>
  );
}
