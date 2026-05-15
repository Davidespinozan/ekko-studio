import { Link } from 'react-router-dom';
import { useTenant } from '@shared/hooks/useTenant';
import { useAuth } from '@shared/hooks/useAuth';
import { useReservasDelUsuario } from '../hooks/useReservas';
import { formatHora } from '../logic/reservaLogic';

export default function Dashboard() {
  const tenant = useTenant();
  const { usuario } = useAuth();
  const { reservas, isLoading } = useReservasDelUsuario();

  const ahora = new Date();
  const proximaReserva = reservas.find(
    (r) => r.status === 'confirmada' && new Date(r.slot_inicio) >= ahora
  );
  const bloqueado = usuario?.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > ahora;

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow">DASHBOARD</p>
          <h1 className="ek-h1">Hola, {usuario?.nombre ?? 'creador'}.</h1>
          <p className="ek-body">Tu espacio en {tenant.nombre} está listo.</p>
        </div>

        {bloqueado && (
          <div className="ek-card ek-card--md" style={{
            borderColor: 'rgba(226, 85, 85, 0.3)',
            background: 'var(--ek-danger-soft)'
          }}>
            <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)' }}>RESTRICCIÓN ACTIVA</p>
            <p className="ek-body" style={{ marginTop: '8px' }}>
              Podrás reservar nuevamente el{' '}
              <strong>
                {new Date(usuario!.bloqueado_hasta!).toLocaleDateString('es-MX', {
                  weekday: 'long', day: 'numeric', month: 'long'
                })}
              </strong>
              .
            </p>
            <p className="ek-body-faint" style={{ marginTop: '8px' }}>
              Esto puede deberse a una inasistencia o suspensión. Contactá a EKKO si tienes dudas.
            </p>
          </div>
        )}

        {!isLoading && proximaReserva && (
          <div className="ek-card--hero">
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '14px' }}>PRÓXIMA SESIÓN</p>
            <h2 className="ek-display-lg" style={{ marginBottom: '6px' }}>
              {proximaReserva.recurso?.nombre ?? 'Recurso'}
            </h2>
            <p className="ek-body-muted">
              {new Date(proximaReserva.slot_inicio).toLocaleDateString('es-MX', {
                weekday: 'long',
                day: 'numeric',
                month: 'long'
              })}{' '}
              · {formatHora(new Date(proximaReserva.slot_inicio))}
            </p>
            <p className="ek-body-faint" style={{ marginTop: '14px' }}>
              Folio: <code style={{ fontFamily: 'var(--ek-font-mono)' }}>{proximaReserva.folio}</code>
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <Link to={`/app/qr/${proximaReserva.id}`} className="ek-cta">
                Ver QR <span style={{ color: 'var(--ek-mustard)' }}>→</span>
              </Link>
            </div>
          </div>
        )}

        {!isLoading && !proximaReserva && (
          <div className="ek-card">
            <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>SIN RESERVAS PRÓXIMAS</p>
            <h3 className="ek-display-md" style={{ marginBottom: '16px' }}>
              ¿Listo para grabar?
            </h3>
            <Link to="/app/reservar" className="ek-cta">Reservar estudio</Link>
          </div>
        )}

        {usuario?.status === 'pendiente_onboarding' && (
          <div className="ek-card ek-card--md" style={{
            borderColor: 'var(--ek-mustard-dim)',
            background: 'var(--ek-mustard-soft)'
          }}>
            <p className="ek-eyebrow ek-eyebrow--mustard">ONBOARDING PENDIENTE</p>
            <p className="ek-body" style={{ marginTop: '8px' }}>
              Aún no completas tu perfil ni activas tu membresía.
              (Esto se construye en el siguiente prompt.)
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
