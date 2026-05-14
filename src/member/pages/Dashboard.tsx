import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';

export default function Dashboard() {
  const tenant = useTenant();
  const { authUser, usuario } = useAuth();

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">DASHBOARD</p>
          <h1 className="ek-h1">
            Hola, {usuario?.nombre ?? 'creador'}.
          </h1>
          <p className="ek-body">
            Tu espacio en {tenant.nombre} está listo.
          </p>
        </div>

        <div className="ek-card ek-card--elevated">
          <p className="ek-eyebrow" style={{ marginBottom: '0.75rem' }}>SESIÓN ACTIVA</p>
          <div className="ek-stack-sm" style={{ fontSize: '0.875rem' }}>
            <div>
              <strong>Email:</strong>{' '}
              <span style={{ color: 'var(--ek-ink-muted)' }}>{authUser?.email}</span>
            </div>
            {usuario && (
              <>
                <div>
                  <strong>Rol:</strong>{' '}
                  <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{usuario.rol}</code>
                </div>
                <div>
                  <strong>Status:</strong>{' '}
                  <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{usuario.status}</code>
                </div>
                <div>
                  <strong>Tenant ID:</strong>{' '}
                  <code style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '0.75rem' }}>
                    {usuario.tenant_id}
                  </code>
                </div>
              </>
            )}
            {!usuario && (
              <p style={{ color: 'var(--ek-warning)' }}>
                ⚠️ Tu perfil aún no está hidratado (puede tomar 1-2 segundos
                después del primer login).
              </p>
            )}
          </div>
        </div>

        <div className="ek-card">
          <p className="ek-eyebrow" style={{ marginBottom: '0.5rem' }}>PRÓXIMAMENTE</p>
          <h3 className="ek-h3" style={{ marginBottom: '0.5rem' }}>Reservar estudio</h3>
          <p style={{ fontSize: '0.875rem', color: 'var(--ek-ink-muted)' }}>
            El sistema de reservas se construye en el siguiente prompt.
          </p>
        </div>
      </div>
    </div>
  );
}
