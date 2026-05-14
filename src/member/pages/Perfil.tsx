import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';

export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">PERFIL</p>
          <h1 className="ek-h2">{usuario?.nombre ?? 'Tu cuenta'}</h1>
        </div>

        <div className="ek-card">
          <div className="ek-stack-sm" style={{ fontSize: '0.875rem' }}>
            <div><strong>Email:</strong> {authUser?.email}</div>
            {usuario?.telefono && <div><strong>Teléfono:</strong> {usuario.telefono}</div>}
            <div><strong>Tenant:</strong> {tenant.nombre}</div>
            <div><strong>Rol:</strong> <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{usuario?.rol}</code></div>
            <div><strong>Status:</strong> <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{usuario?.status}</code></div>
            {usuario?.membresia_tier && (
              <div><strong>Plan:</strong> <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{usuario.membresia_tier}</code></div>
            )}
          </div>
        </div>

        <button onClick={signOut} className="ek-cta ek-cta--secondary ek-cta--full">
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}
