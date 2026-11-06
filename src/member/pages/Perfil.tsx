import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, ArrowRight, LogOut, Pencil, KeyRound, FolderOpen } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { MiSuscripcion } from '@member/components/MiSuscripcion';
import { EditarPerfilModal } from '@member/components/EditarPerfilModal';
import { CambiarPasswordModal } from '@member/components/CambiarPasswordModal';
import { ActivarAvisosPush } from '@shared/components/ActivarAvisosPush';
import { formatFechaEnZona } from '@shared/lib/timezone';

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
        {/* Cabeza del perfil (modelo SALA): avatar grande centrado, nombre, contacto y antigüedad. */}
        <div className="ek-perfil-cabeza">
          <span className="ek-perfil-av">
            {usuario?.avatar_url ? <img src={usuario.avatar_url} alt={usuario.nombre ?? 'Avatar'} /> : initials}
          </span>
          <p className="ek-perfil-nombre">{nombreFormat || 'Tu cuenta'}</p>
          <p className="ek-perfil-meta" style={{ wordBreak: 'break-word' }}>
            {authUser?.email}{usuario?.telefono ? ` · ${usuario.telefono}` : ''}
          </p>
          {usuario?.created_at && (
            <p className="ek-perfil-meta">Miembro desde {formatFechaEnZona(usuario.created_at, { month: 'long', year: 'numeric' })}</p>
          )}
          <button type="button" className="ek-cta ek-cta--secondary" onClick={() => setEditarOpen(true)} style={{ minHeight: '40px', padding: '8px 16px', fontSize: '13px' }}>
            <Pencil size={14} aria-hidden="true" /> Editar perfil
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
