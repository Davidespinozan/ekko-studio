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
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar">PERFIL</p>
          <h1 className="ek-display-md">{nombreFormat || 'Tu cuenta'}</h1>
        </div>

        {/* Avatar */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <span className="ek-avatar-ring">
            {usuario?.avatar_url ? (
              <img
                src={usuario.avatar_url}
                alt={usuario.nombre ?? 'Avatar'}
                style={{
                  width: '120px',
                  height: '120px',
                  borderRadius: '50%',
                  objectFit: 'cover'
                }}
              />
            ) : (
              <div style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--ek-bg-elevated), var(--ek-bg-soft))',
                color: 'var(--ek-mustard)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--ek-font-display)',
                fontSize: '40px',
                fontWeight: 700,
                letterSpacing: '-0.04em'
              }}>
                {initials}
              </div>
            )}
          </span>
        </div>

        <div className="adm-info-grid perfil-info-grid">
          <div className="adm-info-cell">
            <p className="adm-info-label">Email</p>
            <p className="adm-info-value">{authUser?.email}</p>
          </div>
          {usuario?.telefono && (
            <div className="adm-info-cell">
              <p className="adm-info-label">Teléfono</p>
              <p className="adm-info-value">{usuario.telefono}</p>
            </div>
          )}
          <div className="adm-info-cell">
            <p className="adm-info-label">Tenant</p>
            <p className="adm-info-value">{tenant.nombre}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Rol</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.rol}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Status</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.status}</p>
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
