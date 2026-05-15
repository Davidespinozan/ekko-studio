import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';

export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();

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
          <p className="ek-eyebrow">PERFIL</p>
          <h1 className="ek-display-md">{usuario?.nombre ?? 'Tu cuenta'}</h1>
        </div>

        {/* Avatar */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          {usuario?.avatar_url ? (
            <img
              src={usuario.avatar_url}
              alt={usuario.nombre ?? 'Avatar'}
              style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                objectFit: 'cover',
                border: '0.5px solid var(--ek-line)'
              }}
            />
          ) : (
            <div style={{
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              background: 'var(--ek-mustard)',
              color: 'var(--ek-bg)',
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
        </div>

        <div className="adm-info-grid">
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
          {usuario?.membresia_tier && (
            <div className="adm-info-cell">
              <p className="adm-info-label">Plan</p>
              <p className="adm-info-value adm-info-value--mono">{usuario.membresia_tier}</p>
            </div>
          )}
        </div>

        <button onClick={signOut} className="ek-cta ek-cta--secondary ek-cta--full">
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
