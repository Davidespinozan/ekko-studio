import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ArrowRight, LogOut, Pencil, KeyRound, FolderOpen } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { MiSuscripcion } from '@member/components/MiSuscripcion';
import { EditarPerfilModal } from '@member/components/EditarPerfilModal';
import { CambiarPasswordModal } from '@member/components/CambiarPasswordModal';
import { ActivarAvisosPush } from '@shared/components/ActivarAvisosPush';

export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();
  const [editarOpen, setEditarOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

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
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontFamily: 'var(--ek-font-display)', fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--ek-bg)' }}>
              {nombreFormat || 'Tu cuenta'}
            </p>
            <p style={{ margin: '3px 0 0', wordBreak: 'break-word', fontSize: '13px', color: 'rgba(10, 10, 10, 0.6)' }}>{authUser?.email}</p>
            {usuario?.telefono && (
              <p style={{ margin: '1px 0 0', fontSize: '13px', color: 'rgba(10, 10, 10, 0.6)' }}>{usuario.telefono}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setEditarOpen(true)}
            aria-label="Editar perfil"
            title="Editar perfil"
            style={{
              flexShrink: 0,
              width: 38,
              height: 38,
              borderRadius: '50%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(10, 10, 10, 0.06)',
              border: '0.5px solid rgba(10, 10, 10, 0.12)',
              color: 'var(--ek-bg)',
              cursor: 'pointer'
            }}
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
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

        {/* Material de sus sesiones (lo que sube el estudio tras grabar) */}
        <Link
          to="/app/material"
          className="ek-card ek-card--md ek-card-interactive ek-lift"
          style={{ display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}
        >
          <span className="ek-empty-icon" style={{ width: 44, height: 44, margin: 0, flexShrink: 0 }}>
            <FolderOpen size={20} aria-hidden="true" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
              Mi material
            </p>
            <p className="ek-body-faint" style={{ marginTop: '2px' }}>Descarga lo que grabaste en tus sesiones</p>
          </div>
          <ArrowRight size={16} className="ek-quick-action-arrow" aria-hidden="true" />
        </Link>

        {/* Seguridad de la cuenta: antes el miembro no tenía forma de cambiar su clave */}
        <button
          type="button"
          onClick={() => setPasswordOpen(true)}
          className="ek-card ek-card--md ek-card-interactive ek-lift"
          style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left', width: '100%', cursor: 'pointer' }}
        >
          <span className="ek-empty-icon" style={{ width: 44, height: 44, margin: 0, flexShrink: 0 }}>
            <KeyRound size={20} aria-hidden="true" />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
              Cambiar contraseña
            </p>
            <p className="ek-body-faint" style={{ marginTop: '2px' }}>Elige una clave que solo tú conozcas</p>
          </div>
          <ArrowRight size={16} className="ek-quick-action-arrow" aria-hidden="true" />
        </button>

        <button onClick={signOut} className="ek-cta ek-cta--secondary ek-cta--full">
          <LogOut size={16} aria-hidden="true" /> Cerrar sesión
        </button>
      </div>

      {editarOpen && <EditarPerfilModal onClose={() => setEditarOpen(false)} />}
      {passwordOpen && <CambiarPasswordModal onClose={() => setPasswordOpen(false)} />}
    </div>
  );
}
